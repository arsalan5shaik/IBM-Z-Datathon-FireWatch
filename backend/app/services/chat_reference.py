"""Version-controlled NASA FIRMS definitions for the data FireWatch serves.

Each answer quotes or closely paraphrases the cited official page as reviewed at
REVIEWED_AT; it is not model memory and not fetched live. Only definitional
questions about these fields are answered here. Location, time, current-event
and broader science questions keep the normal FireWatch data/research path.
"""

import re

REVIEWED_AT = "2026-10-18T02:30:00Z"
FAQ = {
    "id": "ref-firms-faq",
    "title": "NASA FIRMS Frequently Asked Questions",
    "url": "https://www.earthdata.nasa.gov/data/tools/firms/faq",
}
VIIRS = {
    "id": "ref-firms-viirs",
    "title": "NASA FIRMS VIIRS 375 m active fire attributes",
    "url": "https://firms.modaps.eosdis.nasa.gov/content/descriptions/FIRMS_VIIRS_Firehotspots.html",
}
SOURCES = {page["id"]: page for page in (FAQ, VIIRS)}

# Verbatim official wording supporting each answer; it is the numeric and
# citation evidence the output validator checks the answer against.
EXCERPTS = {
    "ref-firms-faq": (
        "Fire Radiative Power (FRP) is the rate of radiative energy emission per time unit "
        "from all fires within a pixel. FRP has been extensively used as a proxy of fire "
        "intensity to characterize fire types and is related to the rate of biomass "
        "combustion and rate of emissions. It is not recommended to use active fire "
        "locations to estimate burned area. For VIIRS, the confidence values are set to "
        "low, nominal, and high. The confidence field should be used with caution. Each "
        "hotspot/active fire detection represents the center of a pixel flagged as "
        "containing one or more fires or other thermal anomalies (such as volcanoes). For "
        "VIIRS the pixel is approximately 375 m. The location is the center point of the "
        "pixel (not necessarily the coordinates of the actual fire). We are not able to "
        "determine the exact location or size of the fire. In most cases hotspots/fires "
        "are vegetation fires, but sometimes a hotspot/fire is a volcanic eruption or the "
        "flare from a gas well. The fire may have started and ended between satellite "
        "observations; cloud cover, heavy smoke, or tree canopy may completely obscure a fire."
    ),
    "ref-firms-viirs": (
        "FRP depicts the pixel-integrated fire radiative power in megawatts (MW). "
        "Confidence values are set to low (l), nominal (n), and high (h). Low (l) "
        "confidence daytime fire pixels are typically associated with areas of Sun glint "
        "and lower relative temperature anomaly (<15 K) in the mid-infrared channel I4. "
        "Nominal (n) confidence pixels are those free of potential Sun glint contamination "
        "during the day and marked by strong (>15 K) temperature anomaly in either day or "
        "nighttime data. High (h) confidence fire pixels are associated with day or "
        "nighttime saturated pixels. The thermal anomalies are represented as red points "
        "(approximate center of a 375m pixel)."
    ),
}

ANSWERS = {
    "frp": (
        "Fire radiative power (FRP) is the rate of radiative energy emission per time unit "
        "from all fires within a satellite pixel. For VIIRS detections, NASA FIRMS reports "
        "it as pixel-integrated power in megawatts (MW) [ref-firms-viirs]. NASA notes FRP "
        "is widely used as a proxy of fire intensity and relates to the rate of biomass "
        "combustion and emissions [ref-firms-faq]. It is a power measurement, so it is not "
        "acreage or burned area, a fire perimeter, containment, or a probability of fire; "
        "NASA does not recommend using active fire locations to estimate burned area "
        "[ref-firms-faq]."
    ),
    "confidence": (
        "For VIIRS, NASA FIRMS assigns each detection one of three confidence classes: low "
        "(l), nominal (n) or high (h). They are quality classes, not numeric probabilities. "
        "Nominal (n) pixels are free of potential Sun glint contamination during the day "
        "and show a strong (>15 K) temperature anomaly in day or nighttime data, so nominal "
        "does not mean low. Low (l) daytime pixels are typically associated with Sun glint "
        "and a lower (<15 K) anomaly in the mid-infrared channel I4; high (h) pixels are "
        "associated with saturated day or nighttime pixels [ref-firms-viirs]. NASA advises "
        "using the confidence field with caution [ref-firms-faq]. No confidence class by "
        "itself confirms a wildfire."
    ),
    "hotspot": (
        "A satellite hotspot is a detection, not a confirmed wildfire. Each VIIRS hotspot "
        "marks the center of a roughly 375 m pixel flagged as containing one or more fires "
        "or other thermal anomalies; the point is not necessarily the fire's exact "
        "location, and NASA cannot determine the fire's exact location or size. Most "
        "hotspots are vegetation fires, but some are volcanic eruptions or gas-well flares "
        "[ref-firms-faq]. FireWatch therefore never treats a hotspot as an incident: "
        "confirmation, incident names, perimeters, acreage, containment and evacuation "
        "status come from official incident reports by the responsible fire agency or "
        "local authority. No detection does not prove no fire: a fire can start and end "
        "between satellite observations, or be obscured by cloud cover, heavy smoke or "
        "tree canopy [ref-firms-faq]."
    ),
}

TOPICS = {
    "frp": re.compile(r"\bfrp\b|fire radiative power|radiative power", re.I),
    "confidence": re.compile(r"\bconfidence\b", re.I),
    "hotspot": re.compile(r"\bhot ?spots?\b|thermal anomal", re.I),
}
# Confidence is only this definition when it refers to satellite detections.
SATELLITE = re.compile(r"viirs|firms|modis|satellite|detection|hot ?spot|nominal", re.I)
DEFINITION = re.compile(
    r"\bwhat(?:'s| is| are| does| do)\b|\bmean(?:s|ing)?\b|\bdefin|\bdiffer|\bexplain\b"
    r"|\bversus\b|\bvs\b|\bsame as\b|\bis an?\b",
    re.I,
)
# Anything asking for actual data, a place, a time or current events is not a
# definition question; those keep the normal FireWatch data/research path.
OTHER_NEED = re.compile(
    r"\b(?:latest|recent|current(?:ly)?|now|today|tonight|tomorrow|week(?:end)?|near(?:by)?"
    r"|around|show|list|how many|are there|any)\b|detections\b|weather|wind|humid|risk"
    r"|predict|shap|evacuat|shelter|smoke|air quality|histor|caused|camp fire",
    re.I,
)


def topics(message):
    found = [name for name, pattern in TOPICS.items() if pattern.search(message)]
    if "confidence" in found and not SATELLITE.search(message):
        found.remove("confidence")
    return found


def definition_only(message, mentioned):
    """True only for a standalone definition question about FIRMS fields."""
    return bool(
        topics(message)
        and DEFINITION.search(message)
        and not OTHER_NEED.search(message)
        and not mentioned
    )


def evidence(source_id):
    page = SOURCES[source_id]
    return {
        "status": "available",
        "source": "NASA FIRMS",
        "data_kind": "official_definition",
        "official_excerpt": EXCERPTS[source_id],
        "url": page["url"],
        "reviewed_at": REVIEWED_AT,
        "not_fetched_live": True,
    }
