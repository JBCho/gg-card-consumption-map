"""Build tidy CSV exports and the compact data files for the map site (docs/) from processed/*.parquet.

Usage: build_web.py [--web-only]   (--web-only skips the large CSV exports)

All months are mapped onto the 2026-04 행정동 boundaries (vuski/admdongkor ver20260401):
  - 화성시 old codes (41590xxx, until 2025-12) -> new 구 codes by dong name
  - 용인 양지면 41461360 -> 양지읍 41461262
  - 안양 박달1·2동 (41171621/630) and 박달동·호현동 (41171640/650) -> one merged unit
  - 용인 유림동 (41461530) and 유림1·2동 (41461535/536) -> one merged unit
"""
import json, math, os, re, shutil, sys
import numpy as np
import polars as pl

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import topo

sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
P = lambda *a: os.path.join(ROOT, *a)
SITE_DATA = P("docs", "data")
WEB_ONLY = "--web-only" in sys.argv
EXPORT = P("processed", "export")
os.makedirs(SITE_DATA, exist_ok=True)
os.makedirs(EXPORT, exist_ok=True)

MERGES = {  # unit id -> (member codes, display name)
    "41171640": (["41171621", "41171630", "41171640", "41171650"], "박달동·호현동"),
    "41461535": (["41461530", "41461535", "41461536"], "유림1·2동"),
}
RENAMES = {"41461360": "41461262"}


def load_geo(ver):
    g = json.load(open(P("raw_geo", f"HangJeongDong_{ver}.geojson"), encoding="utf-8"))
    return {f["properties"]["adm_cd2"][:8]: f for f in g["features"]
            if f["properties"]["adm_cd2"].startswith("41")}


old_geo, new_geo = load_geo("ver20251231"), load_geo("ver20260401")
dong_name = lambda f: f["properties"]["adm_nm"].split()[-1]


def split_sgg(sggnm):
    m = re.match(r"^(.+?시)(.+구)$", sggnm)
    return (m.group(1), f"{m.group(1)} {m.group(2)}") if m else (sggnm, sggnm)


cat = pl.read_parquet(P("processed", "dong_month_cat.parquet"))
codes = sorted(cat["dong"].unique())

# ---- crosswalk: raw code -> unit id (a code present in new_geo) ----
hw_new = {dong_name(f): k for k, f in new_geo.items() if k.startswith("4159")}
xwalk = {}
for c in codes:
    if c in RENAMES:
        xwalk[c] = RENAMES[c]
    elif c in new_geo:
        xwalk[c] = c
    elif c.startswith("41590") and c in old_geo:
        xwalk[c] = hw_new[dong_name(old_geo[c])]
for uid, (members, _) in MERGES.items():
    for c in members:
        xwalk[c] = uid
missing = [c for c in codes if c not in xwalk]
assert not missing, missing
xw = pl.DataFrame({"dong": list(xwalk), "unit": list(xwalk.values())})

# ---- units ----
unit_ids = sorted(set(xwalk.values()))
units = []
for uid in unit_ids:
    f = new_geo[uid]
    city, sgg_nm = split_sgg(f["properties"]["sggnm"])
    name = MERGES[uid][1] if uid in MERGES else dong_name(f)
    units.append({"id": uid, "nm": name, "sgg": f["properties"]["sgg"], "sggnm": sgg_nm, "city": city})
U = len(units)
uidx = {u["id"]: i for i, u in enumerate(units)}
sggs = sorted({(u["sgg"], u["sggnm"], u["city"]) for u in units})
cities = sorted({u["city"] for u in units})
unit_df = pl.DataFrame(units).rename({"id": "unit"})

months = sorted(cat["ym"].unique())
M = len(months)
midx = {m: i for i, m in enumerate(months)}

names = (pl.read_parquet(P("processed", "cat_names.parquet")).sort("rows", descending=True)
         .unique("cat_cd", keep="first").select("cat_cd", "nm1", "nm2").sort("cat_cd"))
cat = cat.join(xw, on="dong").with_columns(pl.col("cat_cd").str.slice(0, 1).alias("cat1"))
c1_tot = cat.group_by("cat1").agg(pl.col("amt").sum()).sort("amt", descending=True)
cat1_list = c1_tot["cat1"].to_list()
nm1 = dict(names.select(pl.col("cat_cd").str.slice(0, 1), "nm1").unique().iter_rows())
cat2_list = names.with_columns(pl.col("cat_cd").str.slice(0, 1).alias("p")).to_dicts()

# ---- data availability per city (from file log; a city-month exists if its file existed) ----
log = json.load(open(P("processed", "file_log.json"), encoding="utf-8"))
avail = {c: ["0"] * M for c in cities}
for l in log:
    city = l["city"].replace(" ", "")
    if city in avail:
        avail[city][midx[l["yms"][0]]] = "1"
avail = {c: "".join(v) for c, v in avail.items()}

# ---- tidy CSV exports (사용처 x 기간 x 지역) ----
def write_exports():
    exp = (cat.join(unit_df, on="unit", how="left").join(names, on="cat_cd", how="left")
           .select(pl.col("ym").alias("기준년월"), pl.col("city").alias("시군"), pl.col("sgg").alias("시군구코드"),
                   pl.col("sggnm").alias("시군구명"), pl.col("dong").alias("행정동코드_원본"),
                   pl.col("unit").alias("행정동코드_통합"), pl.col("nm").alias("행정동명"),
                   pl.col("cat1").alias("대분류코드"), pl.col("nm1").alias("업종대분류"),
                   pl.col("cat_cd").alias("업종코드"), pl.col("nm2").alias("업종중분류"),
                   pl.col("amt").alias("매출금액"), pl.col("cnt").alias("매출건수"))
           .sort("기준년월", "행정동코드_통합", "업종코드"))
    exp.write_csv(os.path.join(EXPORT, "행정동_월_업종중분류.csv"), include_bom=True)
    exp.write_parquet(os.path.join(EXPORT, "행정동_월_업종중분류.parquet"))
    sgg_exp = (exp.group_by("기준년월", "시군", "시군구코드", "시군구명", "대분류코드", "업종대분류", "업종코드", "업종중분류")
               .agg(pl.col("매출금액").sum(), pl.col("매출건수").sum()).sort("기준년월", "시군구코드", "업종코드"))
    sgg_exp.write_csv(os.path.join(EXPORT, "시군구_월_업종중분류.csv"), include_bom=True)
    daily = (pl.read_parquet(P("processed", "cty_day_cat1.parquet"))
             .with_columns(pl.col("cat1").replace_strict(nm1, default=None).alias("업종대분류"))
             .rename({"ymd": "기준일자", "cty": "시군구코드_원본", "cat1": "대분류코드", "amt": "매출금액", "cnt": "매출건수"}))
    daily.write_csv(os.path.join(EXPORT, "시군구_일별_업종대분류.csv"), include_bom=True)
    print("exports:", exp.shape, sgg_exp.shape, daily.shape)


if not WEB_ONLY:
    write_exports()


# ======================================================================================
# Web data. Everything is split per category key and fetched only when the page needs it:
#   meta.json            names, months, availability, decode constants
#   geo.topo.json        행정동 boundaries as TopoJSON (shared arcs, ~5 m simplification)
#   cube/{key}.bin       unit x month amt & cnt   (key = ALL | 대분류 letter | 중분류 code)
#   prof/{key}.bin       unit x year hour/sex-age/weekday shares + yearly totals (key = ALL | letter)
#   topcat.bin           unit x year x 중분류 amt (hover card "top categories")
# Numbers are log-quantized to uint16 (v = expm1(q / K), rel. error < 0.03%) and stored as
# byte planes (all low bytes, then all high bytes), which gzip noticeably better.
# ======================================================================================
for sub in ("cube", "prof"):
    shutil.rmtree(os.path.join(SITE_DATA, sub), ignore_errors=True)
    os.makedirs(os.path.join(SITE_DATA, sub))
for f in os.listdir(SITE_DATA):
    if f.endswith(".json") or f.endswith(".bin"):
        os.remove(os.path.join(SITE_DATA, f))


def logq(x):
    x = np.asarray(x, dtype=np.float64).ravel()
    mx = float(x.max()) if x.size else 0.0
    K = 65535 / math.log1p(mx) if mx > 0 else 1.0
    q = np.rint(np.log1p(x) * K).astype("<u2")
    return q, K


def planes(q):
    b = q.astype("<u2").view(np.uint8).reshape(-1, 2)
    return b[:, 0].tobytes() + b[:, 1].tobytes()


ui = np.array([uidx[u] for u in cat["unit"]])
mi = np.array([midx[m] for m in cat["ym"]])
amt = cat["amt"].to_numpy().astype(np.float64)
cnt = cat["cnt"].to_numpy().astype(np.float64)
c1v = cat["cat1"].to_numpy()
c2v = cat["cat_cd"].to_numpy()


def write_cube(key, mask):
    A = np.zeros(U * M)
    C = np.zeros(U * M)
    idx = ui[mask] * M + mi[mask]
    np.add.at(A, idx, amt[mask])
    np.add.at(C, idx, cnt[mask])
    qa, Ka = logq(A)
    qc, Kc = logq(C)
    with open(os.path.join(SITE_DATA, "cube", f"{key}.bin"), "wb") as f:
        f.write(planes(qa) + planes(qc))
    return [Ka, Kc]


cubeK = {"ALL": write_cube("ALL", np.ones(len(amt), bool))}
for L in cat1_list:
    cubeK[L] = write_cube(L, c1v == L)
for r in cat2_list:
    cubeK[r["cat_cd"]] = write_cube(r["cat_cd"], c2v == r["cat_cd"])

# ---- profiles ----
years = sorted({m[:4] for m in months})
Y = len(years)
yidx = {y: i for i, y in enumerate(years)}
DIMS = [("hour", list(range(1, 11))), ("sexage", [f"{s}{a}" for s in "MF" for a in range(1, 12)]),
        ("day", list(range(1, 8)))]
D = sum(len(v) for _, v in DIMS)
keys = ["ALL"] + cat1_list
PA = {k: np.zeros((U, Y, D)) for k in keys}


def fill_prof(df, dim_expr, values, offset):
    df = df.join(xw, on="dong").with_columns(pl.col("ym").str.slice(0, 4).alias("y"), dim_expr.alias("v"))
    vpos = {v: i for i, v in enumerate(values)}
    df = df.filter(pl.col("v").is_in(values))
    u = np.array([uidx[x] for x in df["unit"]])
    y = np.array([yidx[x] for x in df["y"]])
    v = np.array([vpos[x] for x in df["v"]]) + offset
    a = df["amt"].to_numpy().astype(np.float64)
    k1 = df["cat1"].to_numpy()
    np.add.at(PA["ALL"], (u, y, v), a)
    for L in cat1_list:
        m = k1 == L
        np.add.at(PA[L], (u[m], y[m], v[m]), a[m])


fill_prof(pl.read_parquet(P("processed", "dong_month_hour.parquet")), pl.col("hour").cast(pl.Int64), DIMS[0][1], 0)
fill_prof(pl.read_parquet(P("processed", "dong_month_demo.parquet")),
          pl.col("sex") + pl.col("age").cast(pl.Utf8), DIMS[1][1], 10)
fill_prof(pl.read_parquet(P("processed", "dong_month_wday.parquet")), pl.col("day").cast(pl.Int64), DIMS[2][1], 32)
profK = {}
for k in keys:
    A = PA[k]
    tot = A[:, :, 0:10].sum(axis=2)  # yearly amount (weights for multi-year ranges)
    sh = np.zeros_like(A)
    for a, b in ((0, 10), (10, 32), (32, 39)):
        g = A[:, :, a:b].sum(axis=2, keepdims=True)
        sh[:, :, a:b] = np.divide(A[:, :, a:b], g, out=np.zeros_like(A[:, :, a:b]), where=g > 0)
    qt, Kt = logq(tot)
    s8 = np.rint(sh * 255).astype(np.uint8)
    with open(os.path.join(SITE_DATA, "prof", f"{k}.bin"), "wb") as f:
        f.write(planes(qt) + s8.tobytes())
    profK[k] = Kt

# ---- top categories per unit x year (hover card) ----
codes2 = [r["cat_cd"] for r in cat2_list]
cpos = {c: i for i, c in enumerate(codes2)}
TC = np.zeros((U, Y, len(codes2)))
yv = np.array([yidx[m[:4]] for m in cat["ym"]])
np.add.at(TC, (ui, yv, np.array([cpos[c] for c in c2v])), amt)
qtc, Ktc = logq(TC)
with open(os.path.join(SITE_DATA, "topcat.bin"), "wb") as f:
    f.write(planes(qtc))

# ---- boundaries -> TopoJSON ----
def polys(uid):
    members = [c for c in MERGES[uid][0] if c in new_geo] if uid in MERGES else [uid]
    out = []
    for c in members:
        g = new_geo[c]["geometry"]
        for poly in (g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]):
            out.append([[(round(x, 6), round(y, 6)) for x, y in ring] for ring in poly])
    return out


sgg_i = {s[0]: i for i, s in enumerate(sggs)}
city_i = {c: i for i, c in enumerate(cities)}
geoms = [({"i": i, "s": sgg_i[u["sgg"]], "c": city_i[u["city"]]}, polys(u["id"])) for i, u in enumerate(units)]
tj = topo.build({"units": geoms}, n=100000, tol=0.00005)
json.dump(tj, open(os.path.join(SITE_DATA, "geo.topo.json"), "w"), separators=(",", ":"))

meta = {
    "months": months, "years": years,
    "cat1": [{"k": k, "nm": nm1[k]} for k in cat1_list],
    "cat2": [{"k": r["cat_cd"], "nm": r["nm2"], "p": r["p"]} for r in cat2_list],
    "units": [{"id": u["id"], "nm": u["nm"], "sgg": u["sgg"]} for u in units],
    "sggs": [{"k": s[0], "nm": s[1], "city": s[2]} for s in sggs],
    "cities": cities, "avail": avail,
    "cubeK": cubeK, "profK": profK, "topcatK": Ktc,
    "dims": [[n, len(v)] for n, v in DIMS],
}
json.dump(meta, open(os.path.join(SITE_DATA, "meta.json"), "w", encoding="utf-8"),
          ensure_ascii=False, separators=(",", ":"))

import gzip
tot_raw = tot_gz = 0
for root, _, files in os.walk(SITE_DATA):
    for f in files:
        b = open(os.path.join(root, f), "rb").read()
        tot_raw += len(b)
        tot_gz += len(gzip.compress(b, 6))
for f in ["meta.json", "geo.topo.json", "cube/ALL.bin", "prof/ALL.bin", "topcat.bin", "cube/D.bin", "cube/Q15.bin"]:
    b = open(os.path.join(SITE_DATA, f), "rb").read()
    print(f"{f:16s} raw {len(b) / 1e3:7.0f}KB  gz {len(gzip.compress(b, 6)) / 1e3:6.0f}KB")
print(f"all files raw {tot_raw / 1e6:.2f}MB gz {tot_gz / 1e6:.2f}MB; units {U} months {M}")
