# 경기 카드소비 지도

**▶ https://jbcho.github.io/gg-card-consumption-map/**

경기데이터드림 「카드 소비 데이터」(2022.01–2026.03, 19개 시군, 원본 CSV 717개 · 8.26억 행)를
사용처(업종) × 기간(월) × 지역(행정동/시군구)으로 전처리하고, 지도 위에 오버레이해 보여주는 데모입니다.

- 지도에 마우스를 올리면: 매출금액·건수·건당금액, 순위, 시군 내 비중, 월별 추이, 상위 업종(중분류), 성별·연령/시간대/요일 분포
- 클릭: 우측 패널을 해당 지역으로 고정 · 월별 추이 차트 드래그: 기간 선택 · ▶: 월별 재생

## 로컬 실행

```bash
python -m http.server 8797 --directory docs
```

http://localhost:8797 을 엽니다 (`file://`로 직접 열면 데이터 로드가 막힙니다).

## 로딩 최적화

첫 화면에 필요한 것만 받고 나머지는 필요할 때 받습니다 (첫 화면 ≈ 150 KB gzip).

| 파일 | 내용 | 받는 시점 |
|---|---|---|
| `data/meta.json` | 이름·월·제공 현황·복원 상수 | 처음 |
| `data/geo.topo.json` | 행정동 경계 TopoJSON (공유 경계 1회 저장, 약 5 m 단순화) | 처음 |
| `data/cube/ALL.bin` | 행정동 × 월 매출금액·건수 (전체 업종) | 처음 |
| `data/prof/ALL.bin`, `data/topcat.bin` | 호버 카드용 분포·상위 업종 | 첫 화면 뒤 유휴 시간 |
| `data/cube/{대분류|중분류}.bin`, `data/prof/{대분류}.bin` | 업종별 큐브 (각 ≈ 60 KB) | 업종 선택 시 |

수치는 uint16 로그 양자화(`v = expm1(q / K)`, 상대오차 < 0.03%) 후 바이트 평면으로 나눠 저장해 gzip 효율을 높였습니다.
원본 정밀도의 집계 결과는 아래 전처리 산출물에 있습니다.

## 다시 만들기

원본 zip은 저장소에 포함하지 않습니다 (약 7.3 GB). 경기데이터드림에서 받아 `../card_consumption_data/`에 둡니다.

```bash
python -I scripts/members.py ../card_consumption_data members.json   # zip 안 CSV 목록·월·시군 파싱
python -I scripts/process.py members.json processed 14               # 717개 CSV 병렬 집계 (~3분)
python -I scripts/build_web.py                                       # 내보내기 CSV + docs/data/*
```

`raw_geo/`에 [vuski/admdongkor](https://github.com/vuski/admdongkor) 행정동 경계(ver20251231, ver20260401)가 필요합니다.
`--web-only`를 주면 대용량 CSV 내보내기를 건너뜁니다.

### 전처리 산출물 (`processed/`, 저장소 미포함)

| 파일 | 내용 |
|---|---|
| `export/행정동_월_업종중분류.csv` (+ .parquet) | 기준년월 × 행정동 × 업종 중분류 매출금액·건수 (104만 행) |
| `export/시군구_월_업종중분류.csv` | 시군구 단위 동일 집계 |
| `export/시군구_일별_업종대분류.csv` | 일별 × 시군구 × 대분류 |
| `dong_month_{hour,demo,wday}.parquet` | 행정동 × 월 × 대분류별 시간대 / 성별·연령 / 요일 분포 |

## 데이터 메모

- 원본 형식이 섞여 있음: UTF-8/CP949, `,`/`|` 구분자, 파일명 3가지 패턴 → 모두 자동 판별.
- 시군별 제공 기간 상이: 부천 ~2024.12, 과천·이천 2025년만, 신규참여 7개 시군은 2023.01~이며 일부 월 누락.
  미제공 월은 지도에서 회색, 합계에서 제외.
- 2026.04 행정동 경계로 통일: 화성시 구 신설 전 코드는 동 이름으로 연결, 안양 박달1·2동→박달동·호현동,
  용인 유림동→유림1·2동은 한 구역으로 합침, 양지면→양지읍.
- 매출은 가맹점 소재지 기준이라 온라인 플랫폼 본사가 있는 성남 분당구 정자1동·백현동 등이 매우 크게 잡힘.
  지도 색은 분위 7단계라 이상치 영향이 작음.
- 시간대(1=0–6시 … 10=23시)·연령(10세 단위) 코드 해석은 원본 분포 기반 추정 — 「경기도 민간데이터 규격서」로 확인 권장.

## 출처 · 라이선스

- 카드 소비 데이터: 경기데이터드림 (KB국민·비씨·롯데·삼성·하나카드), 공공누리 제2유형 (출처표시, 상업적 이용금지)
- 행정동 경계: [vuski/admdongkor](https://github.com/vuski/admdongkor)
- 배경지도: Esri World Gray Canvas, © OpenStreetMap contributors
