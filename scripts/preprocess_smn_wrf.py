#!/usr/bin/env python3
"""
Build a compact, browser/Worker-friendly representation of the latest
SMN deterministic WRF 4 km run and publish it to Cloudflare R2.

The SMN source is public and does not require AWS credentials.
The R2 credentials are read only from GitHub Actions secrets/environment.

Output objects:
  smn/latest.json
  smn/forecast.bin
  smn/metadata.json

Binary layout:
  [lead 0, gridpoint 0..N-1, variables...]
  [lead 1, gridpoint 0..N-1, variables...]
  ...
Each variable is int16 with its own scale. Missing = -32768.

This layout lets the Worker read one tiny contiguous range for a point/hour.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import re
import tempfile
from pathlib import Path

import boto3
import h5netcdf  # noqa: F401 - registers h5netcdf engine
import numpy as np
import xarray as xr

from botocore import UNSIGNED
from botocore.client import Config as BotoConfig
from botocore.exceptions import ClientError
from pyproj import CRS


SMN_BUCKET = "smn-ar-wrf"
SMN_REGION = "us-west-2"
SMN_PREFIX = "DATA/WRF/DET"

R2_BUCKET = os.environ["R2_BUCKET"]
R2_ENDPOINT = os.environ["R2_ENDPOINT"]
R2_ACCESS_KEY_ID = os.environ["R2_ACCESS_KEY_ID"]
R2_SECRET_ACCESS_KEY = os.environ["R2_SECRET_ACCESS_KEY"]

R2_PREFIX = "smn"

LOOKBACK_DAYS = 4

# Variable -> quantization scale.
#
# Temperature:      0.01 C
# RH:               0.1 %
# precipitation:    0.1 mm
# wind speed:       0.01 m/s
# wind direction:   0.1 degree
VARIABLES = {
    "temperature": ("T2", 100.0),
    "humidity": ("HR2", 10.0),
    "precipitation": ("PP", 10.0),
    "windSpeed": ("magViento10", 100.0),
    "windDirection": ("dirViento10", 10.0),
}

MISSING = np.int16(-32768)

KEY_RE = re.compile(
    r"DATA/WRF/DET/(?P<date>\d{4}/\d{2}/\d{2})/"
    r"(?P<init>\d{2})/"
    r"WRFDETAR_01H_(?P<ymd>\d{8})_(?P<cycle>\d{2})_(?P<lead>\d{3})\.nc$"
)


def utcnow() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def make_public_s3():
    """
    Create anonymous/public S3 client for the SMN AWS Open Data bucket.
    """
    return boto3.client(
        "s3",
        region_name=SMN_REGION,
        config=BotoConfig(signature_version=UNSIGNED),
    )


def make_r2():
    """
    Create authenticated Cloudflare R2 S3-compatible client.
    """
    return boto3.client(
        "s3",
        endpoint_url=R2_ENDPOINT,
        aws_access_key_id=R2_ACCESS_KEY_ID,
        aws_secret_access_key=R2_SECRET_ACCESS_KEY,
        region_name="auto",
    )


def list_latest_runs(s3, now: dt.datetime):
    """
    Search the last few days for valid SMN WRF runs.

    A run is considered valid when lead 000 exists.
    """

    candidates: dict[str, dict[int, str]] = {}

    for delta in range(LOOKBACK_DAYS):
        day = now.date() - dt.timedelta(days=delta)

        prefix = f"{SMN_PREFIX}/{day:%Y/%m/%d}/"

        paginator = s3.get_paginator("list_objects_v2")

        for page in paginator.paginate(
            Bucket=SMN_BUCKET,
            Prefix=prefix,
        ):
            for obj in page.get("Contents", []):

                key = obj["Key"]

                m = KEY_RE.match(key)

                if not m:
                    continue

                init_dt = dt.datetime.strptime(
                    f"{m.group('ymd')}{m.group('cycle')}",
                    "%Y%m%d%H",
                ).replace(tzinfo=dt.timezone.utc)

                run_id = init_dt.strftime("%Y%m%d%H")

                lead = int(m.group("lead"))

                candidates.setdefault(run_id, {})[lead] = key

    runs = []

    for run_id, leads in candidates.items():

        if 0 not in leads:
            continue

        init_dt = dt.datetime.strptime(
            run_id,
            "%Y%m%d%H",
        ).replace(tzinfo=dt.timezone.utc)

        runs.append((init_dt, leads))

    runs.sort(
        key=lambda x: x[0],
        reverse=True,
    )

    return runs


def r2_json_get(r2, key: str):
    """
    Read JSON from Cloudflare R2.

    Returns None if the object doesn't exist.
    """

    try:

        obj = r2.get_object(
            Bucket=R2_BUCKET,
            Key=key,
        )

        return json.loads(
            obj["Body"].read()
        )

    except r2.exceptions.NoSuchKey:

        return None

    except ClientError as exc:

        if exc.response.get("Error", {}).get("Code") in {
            "404",
            "NoSuchKey",
        }:
            return None

        raise


def choose_run(runs, r2):
    """
    Prefer newest run.

    If the newest run is already published to R2,
    do nothing.
    """

    if not runs:

        raise RuntimeError(
            "No valid SMN WRF hourly run was found in the last days."
        )

    latest_dt, latest_leads = runs[0]

    latest_id = latest_dt.strftime("%Y%m%d%H")

    current = r2_json_get(
        r2,
        f"{R2_PREFIX}/latest.json",
    )

    if current and current.get("runId") == latest_id:

        print(
            f"Latest run {latest_id} is already published "
            f"({current.get('leadCount', 0)} leads). Nothing to do."
        )

        return None

    print(
        f"Selected latest run: {latest_id} UTC "
        f"with {len(latest_leads)} hourly files."
    )

    return latest_dt, latest_leads


def download_file(
    s3,
    key: str,
    path: Path,
):
    """
    Download one NetCDF file from SMN S3.
    """

    print(
        f"Downloading s3://{SMN_BUCKET}/{key}"
    )

    s3.download_file(
        SMN_BUCKET,
        key,
        str(path),
    )


def find_xy(ds):
    """
    Find SMN WRF projected X/Y coordinates.
    """

    x_name = (
        "x"
        if "x" in ds.coords
        else next(
            (
                n
                for n in ds.coords
                if n.lower() in {"x", "lon_x"}
            ),
            None,
        )
    )

    y_name = (
        "y"
        if "y" in ds.coords
        else next(
            (
                n
                for n in ds.coords
                if n.lower() in {"y", "lat_y"}
            ),
            None,
        )
    )

    if not x_name or not y_name:

        raise RuntimeError(
            f"Could not find x/y coordinates. "
            f"Coordinates: {list(ds.coords)}"
        )

    x = np.asarray(
        ds[x_name].values,
        dtype=np.float64,
    )

    y = np.asarray(
        ds[y_name].values,
        dtype=np.float64,
    )

    if x.ndim != 1 or y.ndim != 1:

        raise RuntimeError(
            "SMN WRF x/y coordinates are expected to be 1-D."
        )

    return (
        x_name,
        y_name,
        x,
        y,
    )


def get_projection(ds):
    """
    Obtain Lambert Conformal Conic projection from
    the NetCDF metadata.
    """

    if "Lambert_Conformal" in ds.variables:

        attrs = dict(
            ds["Lambert_Conformal"].attrs
        )

    else:

        attrs = {}

    # Prefer CF metadata.
    try:

        crs = CRS.from_cf(attrs)

        if not crs.is_projected:

            raise ValueError(
                "CRS is not projected"
            )

    except Exception:

        # WRF/SMN Lambert Conformal fallback.

        lat0 = float(
            attrs["latitude_of_projection_origin"]
        )

        lon0 = float(
            attrs["longitude_of_central_meridian"]
        )

        sp = attrs["standard_parallel"]

        if np.ndim(sp) == 0:

            sp = [
                float(sp),
                float(sp),
            ]

        else:

            sp = [
                float(v)
                for v in np.ravel(sp)[:2]
            ]

            if len(sp) == 1:

                sp = [
                    sp[0],
                    sp[0],
                ]

        earth_radius = float(
            attrs.get(
                "earth_radius",
                6370000.0,
            )
        )

        crs = CRS.from_proj4(
            f"+proj=lcc "
            f"+lat_1={sp[0]} "
            f"+lat_2={sp[1]} "
            f"+lat_0={lat0} "
            f"+lon_0={lon0} "
            f"+R={earth_radius} "
            f"+units=m "
            f"+no_defs"
        )

    cf = crs.to_cf()

    std = cf.get(
        "standard_parallel",
        attrs.get("standard_parallel"),
    )

    if np.ndim(std) == 0:

        std = [
            float(std),
            float(std),
        ]

    else:

        std = [
            float(v)
            for v in np.ravel(std)[:2]
        ]

        if len(std) == 1:

            std = [
                std[0],
                std[0],
            ]

    return {
        "proj": "lambert_conformal_conic",

        "latitudeOfOrigin": float(
            cf.get(
                "latitude_of_projection_origin",
                attrs.get(
                    "latitude_of_projection_origin",
                    0.0,
                ),
            )
        ),

        "centralMeridian": float(
            cf.get(
                "longitude_of_central_meridian",
                attrs.get(
                    "longitude_of_central_meridian",
                    0.0,
                ),
            )
        ),

        "standardParallel": std,

        "earthRadius": float(
            cf.get(
                "earth_radius",
                attrs.get(
                    "earth_radius",
                    6370000.0,
                ),
            )
        ),
    }


def locate_variable(
    ds,
    source_name,
):
    """
    Find required variable inside NetCDF.
    """

    if source_name in ds.variables:

        return ds[source_name]

    raise RuntimeError(
        f"Required SMN variable '{source_name}' "
        f"was not found. "
        f"Variables: {list(ds.variables)}"
    )


def to_2d(
    da,
    x_name,
    y_name,
):
    """
    Convert variable to Y/X 2D array.

    Singleton dimensions such as time are removed.
    """

    for dim in list(da.dims):

        if dim not in {
            x_name,
            y_name,
        }:

            if da.sizes[dim] != 1:

                raise RuntimeError(
                    f"Variable {da.name} has unexpected "
                    f"dimension {dim} "
                    f"size={da.sizes[dim]}"
                )

            da = da.isel(
                {
                    dim: 0
                }
            )

    da = da.transpose(
        y_name,
        x_name,
    )

    return np.asarray(
        da.values,
        dtype=np.float32,
    )


def normalize_values(
    name,
    values,
    units,
):
    """
    Normalize units before quantization.
    """

    units = (
        units or ""
    ).lower().strip()

    if name == "temperature":

        if (
            "k" in units
            and "deg" not in units
            and "c" not in units
        ):

            values = values - 273.15

        elif np.nanmedian(values) > 150:

            values = values - 273.15

    elif name == "humidity":

        if (
            "%" not in units
            and np.nanmax(values) <= 1.5
        ):

            values = values * 100.0

    elif name == "precipitation":

        if units in {
            "m",
            "meter",
            "meters",
        }:

            values = values * 1000.0

        # kg m-2 is numerically equivalent
        # to mm of water.

    return values


def encode_variable(
    values,
    scale,
):
    """
    Quantize float values to int16.
    """

    values = np.asarray(
        values,
        dtype=np.float32,
    )

    finite = np.isfinite(values)

    scaled = np.full(
        values.shape,
        MISSING,
        dtype=np.int16,
    )

    if finite.any():

        clipped = np.clip(
            np.rint(
                values[finite] * scale
            ),
            -32767,
            32767,
        )

        scaled[finite] = clipped.astype(
            np.int16
        )

    return scaled


def process_run(
    s3,
    init_dt,
    leads,
    out_path: Path,
):
    """
    Process all hourly NetCDF files from the selected SMN run.

    IMPORTANT:
    Lead 000 is downloaded as first.nc and reused directly.
    """

    ordered_leads = sorted(leads)

    with tempfile.TemporaryDirectory(
        prefix="smn-wrf-"
    ) as tmp:

        tmpdir = Path(tmp)

        # ---------------------------------------------------------
        # Download and inspect the first available lead.
        # ---------------------------------------------------------

        first_key = leads[
            ordered_leads[0]
        ]

        first_file = tmpdir / "first.nc"

        download_file(
            s3,
            first_key,
            first_file,
        )

        # ---------------------------------------------------------
        # Read grid metadata and validate variables.
        # ---------------------------------------------------------

        with xr.open_dataset(
            first_file,
            engine="h5netcdf",
            decode_coords="all",
        ) as ds:

            x_name, y_name, x, y = find_xy(ds)

            projection = get_projection(ds)

            ny = len(y)
            nx = len(x)

            grid_size = nx * ny

            # Verify all required variables exist
            # before starting the binary output.

            variable_info = {}

            for (
                out_name,
                (source_name, scale),
            ) in VARIABLES.items():

                da = locate_variable(
                    ds,
                    source_name,
                )

                variable_info[out_name] = {
                    "source": source_name,
                    "scale": scale,
                    "units": da.attrs.get(
                        "units",
                        "",
                    ),
                    "longName": da.attrs.get(
                        "long_name",
                        "",
                    ),
                }

        # ---------------------------------------------------------
        # Metadata.
        # ---------------------------------------------------------

        metadata = {
            "model": "SMN-WRF",

            "source": (
                "SMN Argentina / AWS Open Data"
            ),

            "resolutionKm": 4,

            "runId": init_dt.strftime(
                "%Y%m%d%H"
            ),

            "initTime": (
                init_dt
                .isoformat()
                .replace("+00:00", "Z")
            ),

            "leads": ordered_leads,

            "nx": nx,
            "ny": ny,

            "gridSize": grid_size,

            "x0": float(x[0]),
            "y0": float(y[0]),

            "dx": (
                float(x[1] - x[0])
                if nx > 1
                else 4000.0
            ),

            "dy": (
                float(y[1] - y[0])
                if ny > 1
                else 4000.0
            ),

            "projection": projection,

            "variables": variable_info,

            "layout": (
                "lead-major, "
                "gridpoint-major, "
                "variable-interleaved"
            ),

            "dtype": "int16-le",

            "missing": int(MISSING),
        }

        out_path.parent.mkdir(
            parents=True,
            exist_ok=True,
        )

        # ---------------------------------------------------------
        # Generate compact binary.
        # ---------------------------------------------------------

        with out_path.open("wb") as out:

            for idx, lead in enumerate(
                ordered_leads,
                1,
            ):

                key = leads[lead]

                # -------------------------------------------------
                # IMPORTANT FIX:
                #
                # Lead 000 was already downloaded to first.nc.
                # Therefore we MUST use first_file for that lead.
                #
                # Previously the code tried to open 000.nc,
                # which did not exist.
                # -------------------------------------------------

                if lead == ordered_leads[0]:

                    nc_path = first_file

                else:

                    nc_path = (
                        tmpdir
                        / f"{lead:03d}.nc"
                    )

                    download_file(
                        s3,
                        key,
                        nc_path,
                    )

                # -------------------------------------------------
                # Read NetCDF.
                # -------------------------------------------------

                with xr.open_dataset(
                    nc_path,
                    engine="h5netcdf",
                    decode_coords="all",
                ) as ds:

                    record = np.empty(
                        (
                            grid_size,
                            len(VARIABLES),
                        ),
                        dtype="<i2",
                    )

                    # ---------------------------------------------
                    # Process each variable.
                    # ---------------------------------------------

                    for col, (
                        name,
                        (source_name, scale),
                    ) in enumerate(
                        VARIABLES.items()
                    ):

                        da = locate_variable(
                            ds,
                            source_name,
                        )

                        raw = to_2d(
                            da,
                            x_name,
                            y_name,
                        )

                        raw = normalize_values(
                            name,
                            raw,
                            da.attrs.get(
                                "units",
                                "",
                            ),
                        )

                        if raw.shape != (
                            ny,
                            nx,
                        ):

                            raise RuntimeError(
                                f"{source_name} shape "
                                f"{raw.shape} != "
                                f"{(ny, nx)}"
                            )

                        encoded = encode_variable(
                            raw,
                            scale,
                        )

                        record[:, col] = (
                            encoded.reshape(-1)
                        )

                    # ---------------------------------------------
                    # Write one lead to binary.
                    # ---------------------------------------------

                    out.write(
                        record.tobytes(
                            order="C"
                        )
                    )

                print(
                    f"Processed lead "
                    f"{lead:03d} "
                    f"({idx}/{len(ordered_leads)})"
                )

        return metadata


def put_file(
    r2,
    key,
    filename,
    content_type="application/octet-stream",
):
    """
    Upload generated file to Cloudflare R2.
    """

    with open(
        filename,
        "rb",
    ) as fh:

        r2.put_object(
            Bucket=R2_BUCKET,
            Key=key,
            Body=fh,
            ContentType=content_type,
            CacheControl="public, max-age=300",
        )


def main():

    # -------------------------------------------------------------
    # Create clients.
    # -------------------------------------------------------------

    s3 = make_public_s3()

    r2 = make_r2()

    now = utcnow()

    # -------------------------------------------------------------
    # Find latest SMN run.
    # -------------------------------------------------------------

    runs = list_latest_runs(
        s3,
        now,
    )

    selected = choose_run(
        runs,
        r2,
    )

    if selected is None:

        return

    init_dt, leads = selected

    # -------------------------------------------------------------
    # Process and publish.
    # -------------------------------------------------------------

    with tempfile.TemporaryDirectory(
        prefix="smn-publish-"
    ) as tmp:

        tmpdir = Path(tmp)

        bin_path = (
            tmpdir
            / "forecast.bin"
        )

        metadata = process_run(
            s3,
            init_dt,
            leads,
            bin_path,
        )

        metadata["publishedAt"] = (
            utcnow()
            .isoformat()
            .replace(
                "+00:00",
                "Z",
            )
        )

        metadata["leadCount"] = len(
            metadata["leads"]
        )

        metadata["binaryBytes"] = (
            bin_path.stat().st_size
        )

        # ---------------------------------------------------------
        # metadata.json
        # ---------------------------------------------------------

        metadata_path = (
            tmpdir
            / "metadata.json"
        )

        metadata_path.write_text(
            json.dumps(
                metadata,
                indent=2,
            ),
            encoding="utf-8",
        )

        # ---------------------------------------------------------
        # latest.json
        # ---------------------------------------------------------

        latest_path = (
            tmpdir
            / "latest.json"
        )

        latest = {
            "model": "SMN-WRF",

            "runId": metadata[
                "runId"
            ],

            "initTime": metadata[
                "initTime"
            ],

            "leadCount": metadata[
                "leadCount"
            ],

            "leads": metadata[
                "leads"
            ],

            "publishedAt": metadata[
                "publishedAt"
            ],
        }

        latest_path.write_text(
            json.dumps(
                latest,
                indent=2,
            ),
            encoding="utf-8",
        )

        # ---------------------------------------------------------
        # Upload forecast binary.
        # ---------------------------------------------------------

        put_file(
            r2,
            f"{R2_PREFIX}/forecast.bin",
            bin_path,
        )

        # ---------------------------------------------------------
        # Upload metadata.
        # ---------------------------------------------------------

        put_file(
            r2,
            f"{R2_PREFIX}/metadata.json",
            metadata_path,
            "application/json",
        )

        # ---------------------------------------------------------
        # Upload latest.json.
        # ---------------------------------------------------------

        put_file(
            r2,
            f"{R2_PREFIX}/latest.json",
            latest_path,
            "application/json",
        )

        # ---------------------------------------------------------
        # Final status.
        # ---------------------------------------------------------

        print(
            f"Published SMN WRF "
            f"{metadata['runId']} | "
            f"{metadata['leadCount']} leads | "
            f"{metadata['binaryBytes'] / 1024 / 1024:.1f} MiB"
        )


if __name__ == "__main__":
    main()
