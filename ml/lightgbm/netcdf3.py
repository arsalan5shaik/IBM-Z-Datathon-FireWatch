"""Read the classic NetCDF subsets emitted by THREDDS using existing NumPy.

No NetCDF/HDF5/GIS installation is required on s390x. Unsupported formats fail
explicitly; fill masks are applied before unsigned/scale/offset conversion.
"""
import struct
import numpy as np

TYPES = {1: "i1", 2: "S1", 3: ">i2", 4: ">i4", 5: ">f4", 6: ">f8"}


class NetCDF3:
    def __init__(self, path):
        self.path = str(path)
        with open(path, "rb") as f:
            self.f = f
            magic = f.read(4)
            if magic not in (b"CDF\x01", b"CDF\x02"):
                raise ValueError(f"Not classic NetCDF: {magic!r}; request accept=netcdf")
            self.version = magic[-1]
            self.records = self.uint()
            self.dimensions = []
            for _ in range(self.list_count(10)):
                self.dimensions.append((self.string(), self.uint()))
            self.attributes = self.attrs()
            self.variables = {}
            for _ in range(self.list_count(11)):
                name = self.string()
                dims = [self.uint() for _ in range(self.uint())]
                attrs = self.attrs()
                dtype, size = self.uint(), self.uint()
                offset = struct.unpack(">Q" if self.version == 2 else ">I", f.read(8 if self.version == 2 else 4))[0]
                self.variables[name] = {"dims": dims, "attrs": attrs, "dtype": dtype, "size": size, "offset": offset}
        self.record_size = sum(v["size"] for v in self.variables.values() if v["dims"] and self.dimensions[v["dims"][0]][1] == 0)

    def uint(self):
        return struct.unpack(">I", self.f.read(4))[0]

    def string(self):
        length = self.uint()
        result = self.f.read(length).decode("utf-8")
        self.f.read((-length) % 4)
        return result

    def list_count(self, expected):
        tag, count = self.uint(), self.uint()
        if tag not in (0, expected) or (tag == 0 and count != 0):
            raise ValueError("Invalid classic NetCDF header")
        return count

    def attrs(self):
        result = {}
        for _ in range(self.list_count(12)):
            name, kind, count = self.string(), self.uint(), self.uint()
            dtype = np.dtype(TYPES[kind])
            raw = self.f.read(count * dtype.itemsize)
            self.f.read((-len(raw)) % 4)
            if kind == 2:
                value = raw.decode("utf-8").rstrip("\0")
            else:
                values = np.frombuffer(raw, dtype=dtype)
                value = values[0].item() if count == 1 else values.tolist()
            result[name] = value
        return result

    def array(self, name):
        v = self.variables[name]
        dims = [self.dimensions[i] for i in v["dims"]]
        shape = tuple(n or self.records for _, n in dims)
        dtype = np.dtype(TYPES[v["dtype"]])
        if dims and dims[0][1] == 0:
            base = np.memmap(self.path, mode="r", dtype="u1")
            strides = (self.record_size,) + tuple(int(np.prod(shape[i+1:], dtype=int)) * dtype.itemsize for i in range(1, len(shape)))
            raw = np.ndarray(shape, dtype=dtype, buffer=base, offset=v["offset"], strides=strides)
        else:
            raw = np.memmap(self.path, mode="r", dtype=dtype, shape=shape or (), offset=v["offset"])
        mask = np.zeros(raw.shape, dtype=bool)
        for key in ("_FillValue", "missing_value"):
            if key in v["attrs"]:
                mask |= np.isin(raw, np.atleast_1d(v["attrs"][key]))
        if str(v["attrs"].get("_Unsigned", "")).lower() == "true" and dtype.kind == "i":
            raw = raw.view(np.dtype(f">u{dtype.itemsize}"))
        result = np.asarray(raw, dtype=np.float64) * v["attrs"].get("scale_factor", 1) + v["attrs"].get("add_offset", 0)
        result[mask] = np.nan
        return result
