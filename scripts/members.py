"""List every CSV member across the downloaded zips with decoded name, month and city."""
import sys, zipfile, glob, os, re, json
sys.stdout.reconfigure(encoding="utf-8")

def decode_name(info):
    if info.flag_bits & 0x800:
        return info.filename
    raw = info.filename.encode("cp437")
    for enc in ("utf-8", "cp949"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            pass
    return info.filename

def list_members(src_dir):
    out = []
    for zp in sorted(glob.glob(os.path.join(src_dir, "*.zip"))):
        with zipfile.ZipFile(zp) as z:
            for info in z.infolist():
                if not info.filename.lower().endswith(".csv"):
                    continue
                name = decode_name(info)
                # three naming styles: day_{ym}_{city}, day_{city}_{ym}, day_{city} (ym in zip name)
                base = os.path.basename(name)
                if m := re.search(r"day_(\d{4,6})_(.+?)\.csv$", base):
                    ym, city = m.group(1), m.group(2)
                elif m := re.search(r"day_(.+?)_(\d{6})\.csv$", base):
                    city, ym = m.group(1), m.group(2)
                elif (m := re.search(r"day_(.+?)\.csv$", base)) and (zm := re.search(r"_(\d{6})\.zip$", zp)):
                    city, ym = m.group(1), zm.group(1)
                else:
                    print("UNMATCHED", os.path.basename(zp), name)
                    continue
                if len(ym) == 4:
                    ym = "20" + ym
                out.append({"zip": zp, "member": info.filename, "name": name,
                            "ym": ym, "city": city.strip(), "size": info.file_size})
    return out

if __name__ == "__main__":
    ms = list_members(sys.argv[1])
    from collections import Counter, defaultdict
    print("members:", len(ms), "bytes:", sum(m["size"] for m in ms))
    key = Counter((m["ym"], m["city"]) for m in ms)
    print("dupes:", [k for k, v in key.items() if v > 1])
    by_city = defaultdict(list)
    for m in ms:
        by_city[m["city"]].append(m["ym"])
    for c, yms in sorted(by_city.items()):
        yms = sorted(yms)
        print(f"{c}: {len(yms)} months {yms[0]}..{yms[-1]}")
    json.dump(ms, open(sys.argv[2], "w", encoding="utf-8"), ensure_ascii=False, indent=0)
