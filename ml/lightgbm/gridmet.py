"""Bounded gridMET NetCDF-subset extraction and numeric-grid resampling.

Uses the gridMET native ~4 km grid. Native data stay in a cache; a separate
nearest-native-cell table aligns values to existing 3 km cell representatives.
Requires only Python's standard library, so no LinuxONE package installation.
"""
import argparse
import calendar
import csv
import datetime as dt
import gzip
import hashlib
import json
import math
import struct
import time
import urllib.parse
import urllib.request
import urllib.error
import xml.etree.ElementTree as ET
from pathlib import Path

from spatial import digest, grid_features
from netcdf3 import NetCDF3
from grid_samples import sample_polygons

BOUNDS = {"north": 42.04291810977975, "south": 32.506481968615354, "west": -124.50279177200001, "east": -114.09049325085304}
VARS = {"erc": "erc", "tmmx": "tmmx_C", "tmmn": "tmmn_C", "rmin": "rmin_pct", "pr": "pr_mm_day", "vs": "vs_m_s"}
NCSS_VARIABLES = {"erc": "energy_release_component-g", "tmmx": "air_temperature", "tmmn": "air_temperature", "rmin": "relative_humidity", "pr": "precipitation_amount", "vs": "wind_speed"}
NKN_BASE = "https://thredds.northwestknowledge.net/thredds/ncss/grid/MET"
DATA = Path(__file__).resolve().parents[1] / "weather_elevation/data"
NUMERIC_GRID = DATA / "california_grid_numeric_id.geojson"
ERC_PILOT = Path(__file__).resolve().parent / "data/input/firewatch_erc_2024_pilot_numeric_grid.csv"


class CDF:
    """Small NetCDF classic (CDF-1/CDF-2) reader for NCSS subsets."""
    TYPES = {1: ("b", 1), 2: ("h", 2), 3: ("i", 4), 4: ("f", 4), 5: ("d", 8), 6: ("B", 1)}

    def __init__(self, path):
        self.data = Path(path).read_bytes()
        if self.data[:4] not in (b"CDF\x01", b"CDF\x02"):
            raise ValueError(f"Expected uncompressed NetCDF-3, got {self.data[:8]!r}")
        self.version = self.data[3]
        self.pos = 4
        self.records = self.u32()
        self.dims = self.list(10, self.read_dim)
        self.global_attrs = dict(self.list(12, self.read_attr))
        self.vars = self.list(11, self.read_var)

    def u32(self):
        out = struct.unpack_from(">I", self.data, self.pos)[0]; self.pos += 4; return out

    def string(self):
        n = self.u32(); out = self.data[self.pos:self.pos+n].decode("utf-8"); self.pos += (n+3)//4*4; return out

    def list(self, expected_tag, read_item):
        tag = self.u32(); n = self.u32()
        if tag == 0 and n == 0: return []
        if tag != expected_tag or n > 10000: raise ValueError(f"Unexpected NetCDF header list {tag}/{n}")
        return [read_item() for _ in range(n)]

    def values(self, typ, n):
        if typ not in self.TYPES: raise ValueError(f"Unsupported NetCDF type {typ}")
        fmt, size = self.TYPES[typ]; pad = (n*size+3)//4*4
        if self.pos+pad > len(self.data): raise ValueError("Truncated NetCDF values")
        if typ == 6: result = list(self.data[self.pos:self.pos+n])
        else: result = list(struct.unpack_from(">"+fmt*n, self.data, self.pos)) if n else []
        self.pos += pad
        return result

    def read_dim(self): return {"name": self.string(), "size": self.u32()}

    def read_attr(self):
        name = self.string(); typ = self.u32(); n = self.u32()
        values = self.values(typ, n)
        value = bytes(values).decode("utf-8") if typ == 2 else values[0] if len(values) == 1 else values
        return name, value

    def read_var(self):
        name = self.string(); rank = self.u32()
        if rank > 16: raise ValueError("Invalid NetCDF variable rank")
        dimids = [self.u32() for _ in range(rank)]
        attrs = dict(self.list(12, self.read_attr))
        typ, vsize = self.u32(), self.u32()
        begin = struct.unpack_from(">Q", self.data, self.pos)[0] if self.version == 2 else self.u32()
        if self.version == 2: self.pos += 8
        return {"name": name, "dimids": dimids, "attrs": attrs, "type": typ, "vsize": vsize, "begin": begin}

    def array(self, var):
        dims = [self.dims[i]["size"] or self.records for i in var["dimids"]]
        count = math.prod(dims)
        first_record = bool(var["dimids"] and self.dims[var["dimids"][0]]["size"] == 0)
        if not first_record:
            pos = self.pos; self.pos = var["begin"]; values = self.values(var["type"], count); self.pos = pos
        else:
            per_record = math.prod(dims[1:]); pos = self.pos; values = []
            for i in range(dims[0]):
                self.pos = var["begin"] + i*var["vsize"]
                values.extend(self.values(var["type"], per_record))
            self.pos = pos
        return dims, values


def unpack(path, requested_variable):
    nc = NetCDF3(path)
    variables = nc.variables
    tname = "day" if "day" in variables else "time"
    tv = nc.array(tname)
    ta = variables[tname]["attrs"]
    if "since" not in str(ta.get("units", "")):
        raise ValueError(f"Unrecognized time units: {ta.get('units')}")
    unit, origin = ta["units"].split("since", 1)
    origin = dt.datetime.fromisoformat(origin.strip().replace("Z", "+00:00")).replace(tzinfo=None)
    seconds = 86400 if unit.strip().lower().startswith("day") else 3600 if unit.strip().lower().startswith("hour") else None
    if seconds is None: raise ValueError(f"Unsupported time unit: {unit}")
    dates = [origin + dt.timedelta(seconds=float(x)*seconds) for x in tv]
    lat, lon = nc.array("lat"), nc.array("lon")
    data = {}
    for name in (requested_variable,):
        actual = NCSS_VARIABLES[name]
        if actual not in variables:
            raise ValueError(f"NetCDF missing {actual}; available={list(variables)}")
        var = variables[actual]
        dim_info = [nc.dimensions[i] for i in var["dims"]]
        axes = [d[0].lower() for d in dim_info]
        shape = tuple(d[1] or nc.records for d in dim_info)
        if set(axes) not in ({"day", "lat", "lon"}, {"time", "lat", "lon"}):
            raise ValueError(f"Unexpected dimensions for {name}: {axes}")
        # This reader handles fill values, unsigned packed data and scale/offset.
        values = nc.array(actual)
        if axes != ["day", "lat", "lon"] and axes != ["time", "lat", "lon"]:
            order = [axes.index(a) for a in ("day" if "day" in axes else "time", "lat", "lon")]
            values = values.transpose(order)
        values = values.reshape((len(dates), len(lat), len(lon)))
        data[name] = (values, None, 1, 0, var["attrs"], axes, shape)
    return dates, lat.tolist(), lon.tolist(), data


def url_for(variable, start, end, host=None, query_variable=None):
    # NKN NCSS applies the California bounding box before transferring data.
    # addLatLon=true is required for the classic NetCDF coordinate variables.
    base = (host or NKN_BASE).rstrip("/")
    endpoint = f"{base}/{variable}/{variable}_{start.year}.nc"
    params = {"var": query_variable or NCSS_VARIABLES[variable], **BOUNDS,
              "time_start": start.strftime("%Y-%m-%dT00:00:00Z"),
              "time_end": end.strftime("%Y-%m-%dT00:00:00Z"), "accept": "netcdf", "addLatLon": "true"}
    return endpoint + "?" + urllib.parse.urlencode(params)


def discover_variable(variable, year, host=None, timeout=60):
    return f"{(host or NKN_BASE).rstrip('/')}/{variable}/{variable}_{year}.nc", NCSS_VARIABLES[variable]


def probe_pilot(date, output, host=None, timeout=60):
    """Compare one actual ERC pilot label to the provider's native point CSV."""
    if not ERC_PILOT.is_file(): raise FileNotFoundError(ERC_PILOT)
    selected=None
    with ERC_PILOT.open(newline="",encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            if row["local_date"]==date.isoformat() and row["target_erc"].strip():
                selected=row;break
    if selected is None: raise ValueError(f"ERC pilot has no nonmissing target on {date}")
    endpoint,varname=discover_variable("erc",date.year,host,timeout)
    base=(host or "https://tds.gdex.ucar.edu/thredds/ncss/grid/files/d761426").rstrip("/")
    params={"var":varname,"latitude":selected["erc_source_lat"],"longitude":selected["erc_source_lon"],"time":date.isoformat(),"accept":"csv"}
    url=endpoint+"?"+urllib.parse.urlencode(params)
    req=urllib.request.Request(url,headers={"User-Agent":"FireWatch-LGBM/1.0","Accept":"text/csv"})
    with urllib.request.urlopen(req,timeout=timeout) as response: content=response.read(200000).decode("utf-8-sig")
    lines=[line for line in content.splitlines() if line.strip()]
    if len(lines)<2: raise ValueError(f"Point subset has no tabular row: {content[:500]}")
    parsed=list(csv.DictReader(lines))
    numeric=[]
    for r in parsed:
        for key,value in r.items():
            try:
                number=float(value)
                if math.isfinite(number):numeric.append((key,number))
            except (TypeError,ValueError):pass
    target=float(selected["target_erc"])
    matches=[(k,v) for k,v in numeric if v==target]
    report={"provider":"gridMET / GDEX NCSS (NKN product mirror)","request_url":url,"request_bytes":len(url),"response_bytes":len(content.encode()),"pilot_sha256":digest(ERC_PILOT),
            "pilot_date":date.isoformat(),"numeric_cell_id":selected["cell_id"],"erc_source_lat":selected["erc_source_lat"],"erc_source_lon":selected["erc_source_lon"],
            "pilot_erc":target,"provider_csv":parsed,"numeric_response_fields":numeric,"exact_value_match":bool(matches),"matching_fields":[k for k,v in matches],
            "status":"PASS" if matches else "MISMATCH"}
    out=Path(output);out.mkdir(parents=True,exist_ok=True)
    (out/f"gridmet_pilot_value_verification_{date}.json").write_text(json.dumps(report,indent=2,allow_nan=False)+"\n",encoding="utf-8")
    return report


def request(url, cache, timeout):
    key = hashlib.sha256(url.encode()).hexdigest()
    target = Path(cache) / f"{key}.nc"
    if target.exists(): return target, 0.0, True
    target.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "FireWatch-LGBM/1.0", "Accept": "application/x-netcdf"})
    started = time.monotonic(); temp = target.with_suffix(".part")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response, temp.open("wb") as out:
            while True:
                block = response.read(1024*1024)
                if not block: break
                out.write(block)
    except urllib.error.HTTPError as exc:
        detail=exc.read(2000).decode("utf-8","replace"); temp.unlink(missing_ok=True)
        # Include small provider metadata on dataset-variable mismatches. This
        # makes service/catalog drift diagnosable without downloading NetCDF.
        if "Variable:" in detail:
            metadata_url=url.split("?",1)[0]+"/dataset.xml"
            try:
                with urllib.request.urlopen(metadata_url,timeout=30) as response:
                    detail += "\nDATASET_METADATA: " + response.read(16000).decode("utf-8","replace")
            except Exception as meta_error:
                detail += f"\nCould not fetch dataset metadata: {meta_error}"
        raise RuntimeError(f"NCSS HTTP {exc.code} at {url}: {detail}") from exc
    if not temp.read_bytes().startswith((b"CDF\x01", b"CDF\x02")):
        sample = temp.read_bytes()[:300].decode("utf-8", "replace"); temp.unlink(missing_ok=True)
        raise ValueError(f"NCSS response was not NetCDF: {sample}")
    temp.replace(target)
    return target, time.monotonic()-started, False


def point_in_ring(point, ring):
    x,y=point; inside=False
    for (x1,y1),(x2,y2) in zip(ring,ring[1:]):
        if (y1>y)!=(y2>y) and x<(x2-x1)*(y-y1)/(y2-y1)+x1: inside=not inside
    return inside


def point_in_geometry(point, geometry):
    polygons=[geometry["coordinates"]] if geometry["type"]=="Polygon" else geometry["coordinates"]
    return any(point_in_ring(point,rings[0]) and not any(point_in_ring(point,h) for h in rings[1:]) for rings in polygons)


def representative(geometry):
    polygons=[geometry["coordinates"]] if geometry["type"]=="Polygon" else geometry["coordinates"]
    points=[pt for part in polygons for ring in part for pt in ring[:-1]]
    west,east=min(x for x,y in points),max(x for x,y in points)
    south,north=min(y for x,y in points),max(y for x,y in points)
    total=cx=cy=0.0
    for part in polygons:
        for ri,ring in enumerate(part):
            cross=[a[0]*b[1]-b[0]*a[1] for a,b in zip(ring,ring[1:])]
            area=sum(cross)/2; factor=1 if ri==0 else -1
            if abs(area)>1e-18:
                px=sum((a[0]+b[0])*c for a,b,c in zip(ring,ring[1:],cross))/(6*area)
                py=sum((a[1]+b[1])*c for a,b,c in zip(ring,ring[1:],cross))/(6*area)
                total+=factor*abs(area); cx+=factor*abs(area)*px; cy+=factor*abs(area)*py
    point=(cx/total,cy/total) if total else ((west+east)/2,(south+north)/2)
    if point_in_geometry(point,geometry): return point
    y=(south+north)/2; crossings=[]
    for part in polygons:
        for ring in part:
            for a,b in zip(ring,ring[1:]):
                if (a[1]>y)!=(b[1]>y): crossings.append(a[0]+(b[0]-a[0])*(y-a[1])/(b[1]-a[1]))
    crossings.sort()
    for a,b in zip(crossings[::2],crossings[1::2]):
        point=((a+b)/2,y)
        if point_in_geometry(point,geometry): return point
    raise ValueError("Cannot find representative point inside a grid polygon")


def nearest_axis(values, value):
    import bisect
    asc=values[0]<values[-1]; seq=values if asc else list(reversed(values))
    i=bisect.bisect_left(seq,value)
    choices={max(0,min(len(seq)-1,j)) for j in (i-1,i)}
    found=min(choices,key=lambda j:abs(seq[j]-value))
    return found if asc else len(values)-1-found


def native_rows(dates, lat, lon, data):
    records=[]; nlat=len(lat); nlon=len(lon)
    for t,date in enumerate(dates):
        for iy,y in enumerate(lat):
            for ix,x in enumerate(lon):
                row={"date":date.strftime("%Y-%m-%d"),"gridmet_lat":y,"gridmet_lon":x}
                index=t*nlat*nlon+iy*nlon+ix
                for key,(values,fill,scale,offset,attrs,axes,dims) in data.items():
                    indexes={"day":t,"time":t,"lat":iy,"lon":ix}
                    offset_index=0
                    for axis,length in zip(axes,dims): offset_index=offset_index*length+indexes[axis]
                    raw=values[offset_index]
                    if attrs.get("_Unsigned")=="true" and raw<0: raw=raw & 0xffff
                    if attrs.get("_Unsigned")=="true" and fill is not None and fill<0: fill=fill & 0xffff
                    value=None if raw is None or (isinstance(raw,float) and math.isnan(raw)) or (fill is not None and raw==fill) else raw*scale+offset
                    units=str(attrs.get("units","")).strip().lower()
                    if key in ("tmmx","tmmn"):
                        if units in ("k","kelvin","degrees_k"): value=None if value is None else value-273.15
                        elif units not in ("c","degc","degrees_celsius","degree_celsius"): raise ValueError(f"Unexpected {key} unit {units!r}")
                    if key=="rmin" and units not in ("%","percent","percentage"): raise ValueError(f"Unexpected relative-humidity unit {units!r}")
                    if key=="pr" and units not in ("mm","mm/day","mm d-1","kg m-2","kg m-2 day-1"): raise ValueError(f"Unexpected precipitation unit {units!r}")
                    if key=="vs" and units not in ("m s-1","m/s","m s**-1"): raise ValueError(f"Unexpected wind-speed unit {units!r}")
                    if key=="erc" and not (value is None or 0<=value<=150): raise ValueError(f"ERC outside expected index range: {value}")
                    row[VARS[key]]=value
                records.append(row)
    return records


def write_rows(path,fields,rows):
    with Path(path).open("w",newline="",encoding="utf-8") as f:
        writer=csv.DictWriter(f,fieldnames=fields,extrasaction="ignore"); writer.writeheader(); writer.writerows(rows)


def extract(start,end,output,cache,host=None,timeout=180):
    if end<start: raise ValueError("end date precedes start date")
    output=Path(output); output.mkdir(parents=True,exist_ok=True); cache=Path(cache); cache.mkdir(parents=True,exist_ok=True)
    if start<=dt.date(2024,7,20)<=end:
        probe_pilot(dt.date(2024,7,20),output,host,min(timeout,90))
    audit={"provider":"gridMET / Northwest Knowledge Network THREDDS NCSS","product":"daily gridMET ERC fuel model G and colocated meteorological grids",
           "start_date":start.isoformat(),"end_date":end.isoformat(),"bounds_wgs84":BOUNDS,"native_resolution":"1/24 degree (~4 km)",
           "requests":[],"method":"native grid, daily; California bounding-box subset; 3 km polygon interior representative point assigned to nearest native grid center",
           "units":{},"pilot_verification":{}}
    native=[]; axes=None
    for year in range(start.year,end.year+1):
        a=max(start,dt.date(year,1,1)); b=min(end,dt.date(year,12,31))
        arrays={}
        for variable in VARS:
            endpoint,actual_name=discover_variable(variable,year,host,timeout)
            url=url_for(variable,a,b,host,actual_name); path,seconds,reused=request(url,cache,timeout)
            dates,lat,lon,parsed=unpack(path,variable)
            if min(lat)<BOUNDS["south"]-0.05 or max(lat)>BOUNDS["north"]+0.05 or min(lon)<BOUNDS["west"]-0.05 or max(lon)>BOUNDS["east"]+0.05:
                raise ValueError("NCSS returned coordinates outside requested California bounding box")
            expected=[dt.datetime.combine(a+dt.timedelta(days=i),dt.time()) for i in range((b-a).days+1)]
            if dates!=expected: raise ValueError(f"{variable} returned {len(dates)} time slices; expected {len(expected)} exact daily slices {a}..{b}")
            arrays[variable]=(lat,lon,parsed[variable])
            audit["requests"].append({"variable":variable,"url":url,"cache_file":path.name,"sha256":digest(path),"bytes":path.stat().st_size,"seconds":round(seconds,3),"cache_reused":reused})
            audit["units"][variable]=parsed[variable][4].get("units")
        lat,lon,_=arrays["erc"]
        for variable,(other_lat,other_lon,_) in arrays.items():
            if other_lat!=lat or other_lon!=lon: raise ValueError(f"Native grid coordinates differ across {variable}")
        native.extend(native_rows(dates,lat,lon,{k:v[2] for k,v in arrays.items()})); axes=(lat,lon)
    native_path=output/f"gridmet_native_{start}_{end}.csv"
    headers=["date","gridmet_lat","gridmet_lon"]+[VARS[v] for v in VARS]
    write_rows(native_path,headers,native)
    cells=grid_features(NUMERIC_GRID); lat,lon=axes
    locmap={}
    for cell_id,geometry in cells.items():
        x,y=representative(geometry); iy=nearest_axis(lat,y); ix=nearest_axis(lon,x); gy,gx=lat[iy],lon[ix]
        distance=math.hypot((x-gx)*111.32*math.cos(math.radians(y)),(y-gy)*110.57)
        locmap[cell_id]=(gy,gx,distance)
    index={(r["date"],r["gridmet_lat"],r["gridmet_lon"]):r for r in native}
    aligned=[]
    for date in sorted({r["date"] for r in native}):
        for cell_id,(gy,gx,distance) in locmap.items():
            src=index.get((date,gy,gx))
            if src is None: raise ValueError(f"No native data for {date}, {gy}, {gx}")
            aligned.append({"cell_id":cell_id,"date":date,**{k:src[k] for k in headers[3:]},"gridmet_lat":gy,"gridmet_lon":gx,"gridmet_center_distance_km":round(distance,4)})
    aligned_path=output/f"gridmet_cell_daily_{start}_{end}.csv"
    write_rows(aligned_path,["cell_id","date"]+headers[3:]+["gridmet_lat","gridmet_lon","gridmet_center_distance_km"],aligned)
    audit["native_grid_shape"]={"lat":len(lat),"lon":len(lon),"days":len({r["date"] for r in native}),"cells_per_day":len(lat)*len(lon)}
    audit["outputs"]={p.name:{"sha256":digest(p),"bytes":p.stat().st_size,"rows":sum(1 for _ in p.open(encoding="utf-8"))-1} for p in (native_path,aligned_path)}
    audit["cell_assignment"]={"grid_cells":len(cells),"method":"polygon interior representative point; nearest center in regular WGS84 lat/lon axes","max_center_distance_km":max(r["gridmet_center_distance_km"] for r in aligned),"mean_center_distance_km":round(sum(r["gridmet_center_distance_km"] for r in aligned)/len(aligned),4)}
    if ERC_PILOT.exists() and start<=dt.date(2024,7,20) and end>=dt.date(2024,7,26):
        pilot=[]
        with ERC_PILOT.open(newline="",encoding="utf-8-sig") as f:
            for row in csv.DictReader(f):
                try: target=float(row["target_erc"])
                except (ValueError,TypeError): continue
                if start<=dt.date.fromisoformat(row["local_date"])<=end: pilot.append((row,target))
        source_index={(r["date"],r["gridmet_lat"],r["gridmet_lon"]):r["erc"] for r in native}
        compared=[]; unmatched=0
        for row,target in pilot:
            key=(row["local_date"],float(row["erc_source_lat"]),float(row["erc_source_lon"]))
            if key not in source_index: unmatched+=1
            else: compared.append((target,source_index[key]))
        audit["pilot_verification"]={"pilot_file_sha256":digest(ERC_PILOT),"rows_with_real_targets":len(pilot),"native_source_coordinate_matches":len(compared),"unmatched_source_coordinates":unmatched,"exact_value_matches":sum(a==b for a,b in compared),"value_mismatches":sum(a!=b for a,b in compared),"max_absolute_difference":max((abs(a-b) for a,b in compared),default=None),"status":"PASS" if compared and all(a==b for a,b in compared) else "FAIL_OR_NO_SOURCE_COORDINATE_MATCH"}
    audit_path=output/f"gridmet_extraction_{start}_{end}.json"
    audit_path.write_text(json.dumps(audit,indent=2,allow_nan=False)+"\n",encoding="utf-8")
    return audit


def extract_training_inputs(start, end, output, cache, host=None, timeout=180):
    """Write gzip cell-day ERC and weather inputs, streaming by date.

    ERC is emitted only for the requested label dates. Weather includes one
    preceding gridMET day so the training pipeline can apply its past-only lag.
    All cell assignments use EPSG:3310 lattice-square centers inferred from
    the numeric polygon boundaries; native gridMET pixels are never relabeled
    as 3 km observations or assumed to share cell centers.
    """
    import numpy as np
    from grid_samples import sample_polygons
    if end < start:
        raise ValueError("end date precedes start date")
    grid_rows = sample_polygons(NUMERIC_GRID)
    ids = [str(r["cell_id"]) for r in grid_rows]
    id_set = set(ids)
    # Prefer the pilot's per-cell ERC source coordinate wherever it has a
    # numeric-grid match. It records the verified tie decision for 46,200
    # cells. The remaining cells use their geometry-derived 3 km square center.
    pilot_mapping_path = ERC_PILOT
    pilot_sources = {}
    with pilot_mapping_path.open(newline="", encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            cell_id = r["cell_id"]
            if cell_id not in id_set or not r["erc_source_lat"].strip() or not r["erc_source_lon"].strip():
                continue
            coords = (r["erc_source_lat"], r["erc_source_lon"])
            if cell_id in pilot_sources and pilot_sources[cell_id] != coords:
                raise ValueError(f"ERC pilot source coordinate varies across dates for cell {cell_id}")
            pilot_sources[cell_id] = coords
    sample_lat = np.asarray([float(pilot_sources[i][0]) if i in pilot_sources else float(r["sample_lat"])
                             for i, r in zip(ids, grid_rows)])
    sample_lon = np.asarray([float(pilot_sources[i][1]) if i in pilot_sources else float(r["sample_lon"])
                             for i, r in zip(ids, grid_rows)])
    output, cache = Path(output), Path(cache)
    output.mkdir(parents=True, exist_ok=True)
    cache.mkdir(parents=True, exist_ok=True)
    weather_start = start - dt.timedelta(days=1)
    weather_path = output / "weather_daily.csv.gz"
    erc_path = output / "erc_daily.csv.gz"
    fields = ["cell_id", "date", *[VARS[k] for k in ("tmmx", "tmmn", "rmin", "pr", "vs")]]
    request_log = []
    target_missing = 0
    rows_written = {"erc": 0, "weather": 0}
    temperature_order_anomalies = 0

    def read_subset(variable, a, b):
        url = url_for(variable, a, b, host)
        path, seconds, reused = request(url, cache, timeout)
        dates_out, lat, lon, data = unpack(path, variable)
        expected = [dt.datetime.combine(a + dt.timedelta(days=i), dt.time()) for i in range((b-a).days+1)]
        if dates_out != expected:
            raise ValueError(f"{variable}: returned dates do not exactly match {a}..{b}")
        # NCSS includes the nearest native pixel center just beyond a requested
        # edge; half a 1/24-degree pixel is expected on a bounded raster crop.
        tol = 1.0 / 24
        if (min(lat) < BOUNDS["south"]-tol or max(lat) > BOUNDS["north"]+tol
                or min(lon) < BOUNDS["west"]-tol or max(lon) > BOUNDS["east"]+tol):
            raise ValueError(f"{variable}: NCSS coordinates exceed the California subset bounds")
        request_log.append({"variable": variable, "start": a.isoformat(), "end": b.isoformat(),
                            "url": url, "sha256": digest(path), "bytes": path.stat().st_size,
                            "seconds": round(seconds, 3), "cache_reused": reused,
                            "units": data[variable][4].get("units")})
        return dates_out, np.asarray(lat), np.asarray(lon), data[variable][0]

    def nearest(values, wanted):
        order = np.argsort(values)
        sorted_values = values[order]
        pos = np.searchsorted(sorted_values, wanted)
        lo = np.clip(pos-1, 0, len(values)-1)
        hi = np.clip(pos, 0, len(values)-1)
        chosen = np.where(np.abs(sorted_values[lo]-wanted) <= np.abs(sorted_values[hi]-wanted), lo, hi)
        return order[chosen]

    with gzip.open(weather_path, "wt", newline="", encoding="utf-8") as wf, \
         gzip.open(erc_path, "wt", newline="", encoding="utf-8") as ef:
        ww = csv.writer(wf); ww.writerow(fields)
        ew = csv.writer(ef); ew.writerow(["cell_id", "date", "erc"])
        first_year, last_year = weather_start.year, end.year
        for year in range(first_year, last_year+1):
            wa = max(weather_start, dt.date(year, 1, 1))
            wb = min(end, dt.date(year, 12, 31))
            if wa > wb:
                continue
            weather_arrays = {}
            axes = None
            for key in ("tmmx", "tmmn", "rmin", "pr", "vs"):
                dates_out, lat, lon, values = read_subset(key, wa, wb)
                if axes is None:
                    axes = (dates_out, lat, lon)
                elif dates_out != axes[0] or not np.array_equal(lat, axes[1]) or not np.array_equal(lon, axes[2]):
                    raise ValueError(f"Native grid/date axes differ for {key}_{year}")
                if key in ("tmmx", "tmmn"):
                    unit = str(next(x["units"] for x in request_log[::-1] if x["variable"] == key)).strip().lower()
                    if unit in ("k", "kelvin"):
                        values = values - 273.15
                    elif unit not in ("c", "degc", "degrees_celsius", "degree_celsius"):
                        raise ValueError(f"Unexpected temperature unit for {key}: {unit}")
                weather_arrays[key] = values
                print(f"downloaded {key} {wa}..{wb}: {values.nbytes:,} decoded bytes", flush=True)
            lat_idx = nearest(axes[1], sample_lat)
            lon_idx = nearest(axes[2], sample_lon)
            erc_dates = None
            erc_values = None
            ea, eb = max(start, dt.date(year, 1, 1)), min(end, dt.date(year, 12, 31))
            if ea <= eb:
                erc_dates, elat, elon, erc_values = read_subset("erc", ea, eb)
                if not np.array_equal(elat, axes[1]) or not np.array_equal(elon, axes[2]):
                    raise ValueError("ERC and weather native grid coordinates differ")
                erc_lat_idx, erc_lon_idx = nearest(elat, sample_lat), nearest(elon, sample_lon)
            else:
                erc_dates = []
            weather_date_index = {d.date(): i for i, d in enumerate(axes[0])}
            label_date_index = {d.date(): i for i, d in enumerate(erc_dates)}
            for day, date_obj in enumerate(axes[0]):
                date = date_obj.date()
                for cell_pos, cell_id in enumerate(ids):
                    vals = [weather_arrays[k][day, lat_idx[cell_pos], lon_idx[cell_pos]] for k in ("tmmx", "tmmn", "rmin", "pr", "vs")]
                    tmax, tmin, rhmin, precip, wind = vals
                    if (np.isfinite(tmax) and not -100 <= tmax <= 70) or (np.isfinite(tmin) and not -100 <= tmin <= 70):
                        raise ValueError(f"Temperature outside plausible Celsius range at {cell_id} {date}")
                    if np.isfinite(tmax) and np.isfinite(tmin) and tmax < tmin:
                        # Preserve the provider's actual values and report the
                        # rare source inconsistency; do not fabricate a fix.
                        temperature_order_anomalies += 1
                    if np.isfinite(rhmin) and not 0 <= rhmin <= 100:
                        raise ValueError(f"Relative humidity outside [0,100] at {cell_id} {date}")
                    if np.isfinite(precip) and precip < 0:
                        raise ValueError(f"Negative daily precipitation at {cell_id} {date}")
                    if np.isfinite(wind) and wind < 0:
                        raise ValueError(f"Negative daily wind speed at {cell_id} {date}")
                    ww.writerow([cell_id, date.isoformat(), *["" if not np.isfinite(v) else float(v) for v in vals]])
                    rows_written["weather"] += 1
                    if date in label_date_index:
                        ix = label_date_index[date]
                        value = erc_values[ix, erc_lat_idx[cell_pos], erc_lon_idx[cell_pos]]
                        if np.isfinite(value):
                            if not 0 <= value <= 150:
                                raise ValueError(f"ERC-G outside expected [0,150] index range at {cell_id} {date}: {value}")
                            ew.writerow([cell_id, date.isoformat(), float(value)])
                            rows_written["erc"] += 1
                        else:
                            target_missing += 1
                if day % 31 == 0:
                    print(f"aligned {date.isoformat()} ({year}); weather rows={rows_written['weather']:,}, ERC rows={rows_written['erc']:,}", flush=True)
            del weather_arrays, erc_values
    audit = {"provider": "gridMET ERC-G and daily meteorology via Northwest Knowledge Network THREDDS NCSS",
             "label_start": start.isoformat(), "label_end": end.isoformat(),
             "weather_source_start_including_one_day_warmup": weather_start.isoformat(),
             "weather_source_end": end.isoformat(), "target_units": "Unitless ERC-G index",
             "target": "Energy Release Component, fuel model G (ERC-G); environmental fire-danger regression target, not ignition probability",
             "native_resolution": "1/24 degree (~4 km)", "bounds_wgs84": BOUNDS,
             "daily_convention": "gridMET daily date; MST day, equivalent to 07:00 UTC boundary",
             "spatial_method": "numeric GeoJSON polygon boundaries -> EPSG:3310 lattice center -> nearest gridMET native pixel; use pilot-recorded ERC source coordinate for matched numeric IDs, geometry-derived square center for uncovered IDs; native resolution retained",
             "pilot_erc_source_mapping_sha256": digest(pilot_mapping_path),
             "pilot_source_mapping_cells": len(pilot_sources),
             "fallback_grid_center_mapping_cells": len(ids)-len(pilot_sources),
             "numeric_grid_sha256": digest(NUMERIC_GRID), "grid_cells": len(ids), "requests": request_log,
             "label_dates": (end-start).days+1,
             "row_counts": rows_written, "missing_erc_cell_days_excluded": target_missing,
             "weather_quality_anomalies": {"tmmx_below_tmmn_source_records": temperature_order_anomalies},
             "outputs": {p.name: {"bytes": p.stat().st_size, "sha256": digest(p)} for p in (weather_path, erc_path)}}
    manifest = output / "gridmet_training_inputs_manifest.json"
    manifest.write_text(json.dumps(audit, indent=2, allow_nan=False)+"\n", encoding="utf-8")
    return audit


def main():
    parser=argparse.ArgumentParser(description=__doc__); sub=parser.add_subparsers(dest="command",required=True)
    p=sub.add_parser("extract"); p.add_argument("--start",required=True,type=dt.date.fromisoformat); p.add_argument("--end",required=True,type=dt.date.fromisoformat)
    p.add_argument("--output",required=True); p.add_argument("--cache",required=True); p.add_argument("--host"); p.add_argument("--timeout",type=int,default=180)
    f=sub.add_parser("extract-training"); f.add_argument("--start",required=True,type=dt.date.fromisoformat); f.add_argument("--end",required=True,type=dt.date.fromisoformat)
    f.add_argument("--output",required=True); f.add_argument("--cache",required=True); f.add_argument("--host"); f.add_argument("--timeout",type=int,default=180)
    args=parser.parse_args()
    if args.command=="extract-training":
        result=extract_training_inputs(args.start,args.end,args.output,args.cache,args.host,args.timeout)
        print(json.dumps({"outputs":result["outputs"],"row_counts":result["row_counts"],
                          "missing_erc_cell_days_excluded":result["missing_erc_cell_days_excluded"],
                          "subset_bytes":sum(x["bytes"] for x in result["requests"]),
                          "network_download_bytes_this_run":sum(x["bytes"] for x in result["requests"] if not x["cache_reused"]),
                          "requests":len(result["requests"])},indent=2))
        return
    try: result=extract(args.start,args.end,args.output,args.cache,args.host,args.timeout)
    except RuntimeError as error:
        print(str(error)); raise SystemExit(2)
    print(json.dumps({"outputs":result["outputs"],"native_grid_shape":result["native_grid_shape"],"cell_assignment":result["cell_assignment"],"pilot_verification":result["pilot_verification"],"download_bytes":sum(x["bytes"] for x in result["requests"]),"requests":len(result["requests"])},indent=2))


if __name__=="__main__": main()
