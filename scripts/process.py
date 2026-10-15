"""Aggregate raw daily card-spending CSVs (inside the downloaded zips) into compact tables.

Outputs (parquet, in processed/parts then merged):
  dong_month_cat   ym, cty, dong, cat_cd             -> amt, cnt   (사용처 중분류 x 기간 x 행정동)
  dong_month_hour  ym, dong, cat1, hour              -> amt, cnt
  dong_month_demo  ym, dong, cat1, sex, age          -> amt, cnt
  dong_month_wday  ym, dong, cat1, day               -> amt, cnt
  cty_day_cat1     ymd, cty, cat1                    -> amt, cnt   (daily trend per 시군구)
  cat_names        cat_cd, nm1, nm2                  -> rows
"""
import os
os.environ.setdefault("POLARS_MAX_THREADS", "2")
import sys, json, zipfile, time, io
from concurrent.futures import ProcessPoolExecutor, as_completed
import polars as pl

sys.stdout.reconfigure(encoding="utf-8")

COLS = ["ta_ymd", "cty_rgn_no", "admi_cty_no", "card_tpbuz_cd", "card_tpbuz_nm_1",
        "card_tpbuz_nm_2", "hour", "sex", "age", "day", "amt", "cnt"]
SCHEMA = {c: pl.Utf8 for c in COLS}
SUM = [pl.col("amt").sum(), pl.col("cnt").sum()]


def read_member(zp, member):
    with zipfile.ZipFile(zp) as z:
        raw = z.read(member)
    if raw.startswith(b"\xef\xbb\xbf"):
        raw = raw[3:]
    try:
        raw.decode("utf-8")
        enc = "utf-8"
    except UnicodeDecodeError:
        raw = raw.decode("cp949", errors="replace").encode("utf-8")
        enc = "cp949"
    header = raw[:300].split(b"\n", 1)[0].decode().strip().lower().replace('"', "")
    sep = max([",", "|", "\t"], key=header.count)
    has_header = header.startswith("ta_ymd")
    if has_header and header.split(sep) != COLS:
        raise ValueError(f"unexpected header: {header}")
    df = pl.read_csv(io.BytesIO(raw), has_header=has_header, new_columns=COLS, separator=sep,
                     schema_overrides=SCHEMA, quote_char='"')
    return df, f"{enc} sep={sep!r} header={has_header}"


def process(job):
    t0 = time.time()
    df, enc = read_member(job["zip"], job["member"])
    df = df.with_columns(
        pl.col("ta_ymd").str.strip_chars(),
        pl.col("cty_rgn_no").str.strip_chars().alias("cty"),
        pl.col("admi_cty_no").str.strip_chars().alias("dong"),
        pl.col("card_tpbuz_cd").str.strip_chars().alias("cat_cd"),
        pl.col("hour").str.strip_chars().cast(pl.Int8, strict=False),
        pl.col("sex").str.strip_chars(),
        pl.col("age").str.strip_chars().cast(pl.Int8, strict=False),
        pl.col("day").str.strip_chars().cast(pl.Int8, strict=False),
        pl.col("amt").str.strip_chars().cast(pl.Int64, strict=False),
        pl.col("cnt").str.strip_chars().cast(pl.Int64, strict=False),
    ).with_columns(
        pl.col("ta_ymd").str.slice(0, 6).alias("ym"),
        pl.col("cat_cd").str.slice(0, 1).alias("cat1"),
    )
    out = {
        "dong_month_cat": df.group_by("ym", "cty", "dong", "cat_cd").agg(SUM),
        "dong_month_hour": df.group_by("ym", "dong", "cat1", "hour").agg(SUM),
        "dong_month_demo": df.group_by("ym", "dong", "cat1", "sex", "age").agg(SUM),
        "dong_month_wday": df.group_by("ym", "dong", "cat1", "day").agg(SUM),
        "cty_day_cat1": df.group_by(pl.col("ta_ymd").alias("ymd"), "cty", "cat1").agg(SUM),
        "cat_names": df.group_by("cat_cd", pl.col("card_tpbuz_nm_1").alias("nm1"),
                                 pl.col("card_tpbuz_nm_2").alias("nm2")).agg(pl.len().alias("rows")),
    }
    stats = {"rows": df.height, "enc": enc, "amt": int(df["amt"].sum()),
             "null_amt": int(df["amt"].null_count()), "yms": sorted(df["ym"].unique().to_list()),
             "secs": round(time.time() - t0, 1)}
    return job, out, stats


def main(members_json, out_dir, workers=12, limit=None):
    jobs = json.load(open(members_json, encoding="utf-8"))
    jobs.sort(key=lambda j: -j["size"])  # big files first for better packing
    if limit:
        jobs = jobs[:limit]
    os.makedirs(out_dir, exist_ok=True)
    acc = {}
    log = []
    t0 = time.time()
    with ProcessPoolExecutor(workers) as ex:
        futs = [ex.submit(process, j) for j in jobs]
        for i, f in enumerate(as_completed(futs), 1):
            job, out, stats = f.result()
            for k, v in out.items():
                acc.setdefault(k, []).append(v)
            log.append({"name": job["name"], "file_ym": job["ym"], "city": job["city"], **stats})
            if i % 20 == 0 or i == len(jobs):
                print(f"{i}/{len(jobs)} files, {time.time() - t0:.0f}s", flush=True)
    keys = {"dong_month_cat": ["ym", "cty", "dong", "cat_cd"],
            "dong_month_hour": ["ym", "dong", "cat1", "hour"],
            "dong_month_demo": ["ym", "dong", "cat1", "sex", "age"],
            "dong_month_wday": ["ym", "dong", "cat1", "day"],
            "cty_day_cat1": ["ymd", "cty", "cat1"],
            "cat_names": ["cat_cd", "nm1", "nm2"]}
    for k, parts in acc.items():
        agg = [pl.col("rows").sum()] if k == "cat_names" else SUM
        df = pl.concat(parts).group_by(keys[k]).agg(agg).sort(keys[k])
        df.write_parquet(os.path.join(out_dir, f"{k}.parquet"))
        print(k, df.shape)
    json.dump(log, open(os.path.join(out_dir, "file_log.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print("total rows:", sum(l["rows"] for l in log), "secs:", round(time.time() - t0))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 12,
         int(sys.argv[4]) if len(sys.argv) > 4 else None)
