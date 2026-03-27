# S&P 500 데이터 갱신 가이드

이 프로젝트는 프론트엔드에서 JSON을 읽어 버블 차트를 렌더링합니다.
최신 데이터 갱신은 브라우저 직접 호출이 아니라 배치 스크립트로 수행합니다.

## 데이터 공급자(현재 구현)

- 구성종목: DataHub CSV (`CONSTITUENTS_CSV_URL`)
- 지표: Financial Modeling Prep **stable** API
  - `GET /stable/quote?symbol=...`
  - `GET /stable/income-statement?symbol=...&period=quarter&limit=4` (최근 4분기 합산으로 TTM)

## 준비

1. Node.js 18+ 설치 (내장 `fetch` 사용).
2. `.env.example`를 참고해 `.env`를 만들고 값을 채웁니다.

PowerShell 예시:

```powershell
node .\scripts\update-data.js
```

`scripts/update-data.js`는 프로젝트 루트의 `.env`를 자동으로 읽습니다.

## Supabase Storage 업로드(수동)

업로드에는 **Service Role Key**가 필요합니다(anon key로는 보통 불가).

PowerShell 예시(값은 본인 프로젝트에 맞게):

```powershell
curl.exe -X POST `
  "https://YOUR_PROJECT_REF.supabase.co/storage/v1/object/s%26p500/latest/data.json" `
  -H "Authorization: Bearer YOUR_SERVICE_ROLE_KEY" `
  -H "apikey: YOUR_SERVICE_ROLE_KEY" `
  -H "Content-Type: application/json" `
  -H "x-upsert: true" `
  --data-binary "@data.json"
```

버킷 이름에 `&`가 들어가면 URL에서는 `%26`로 인코딩하는 것이 안전합니다.

## GitHub Actions에 넣을 값

워크플로우: `.github/workflows/update-sp500-data.yml`

### Repository secrets

- `FMP_API_KEY`
- `SUPABASE_URL` (예: `https://xxxx.supabase.co`)
- `SUPABASE_SERVICE_ROLE_KEY`

### Repository variables

- `FMP_BASE_URL` (예: `https://financialmodelingprep.com/stable`)
- `SUPABASE_BUCKET` (예: `s%26p500` 또는 Supabase UI에 표시되는 버킷명 그대로)
- `SUPABASE_OBJECT_PATH` (예: `latest/data.json`)

## 출력 형식

스크립트는 `data.json`을 아래 포맷으로 갱신합니다.

```json
{
  "as_of": "2026-03-27",
  "generated_at": "2026-03-27T00:00:00.000Z",
  "data_source": "Constituents: DataHub CSV, Metrics: Financial Modeling Prep stable API",
  "record_count": 503,
  "data": [
    {
      "symbol": "AAPL",
      "name": "Apple Inc.",
      "sector": "Information Technology",
      "ttm_revenue_b": 390.2,
      "ttm_net_income_b": 96.1,
      "market_cap_b": 3200.8,
      "price_change_pct": 22.5,
      "price": 210.3,
      "profit_margin": 24.6
    }
  ]
}
```

`index.html`은 기존 배열 포맷과 위 메타 포맷을 모두 지원합니다.
