# S&P 500 데이터 갱신 가이드

이 프로젝트는 프론트엔드에서 `data.json`을 읽어 버블 차트를 렌더링합니다.
최신 데이터 갱신은 브라우저 직접 호출이 아니라 배치 스크립트로 수행합니다.

## 데이터 공급자

- 기본 공급자: Financial Modeling Prep (FMP) API v3
- 사용 엔드포인트:
  - `/sp500_constituent` (티커/회사명/섹터)
  - `/quote/{commaSeparatedSymbols}` (가격, 시가총액, 변동률)
  - `/income-statement/{symbol}?period=quarter&limit=4` (TTM 매출/순이익 계산)

## 준비

1. Node.js 18+ 설치 (내장 `fetch` 사용).
2. `.env.example`를 참고해 환경변수 설정.

PowerShell 예시:

```powershell
$env:FMP_API_KEY="YOUR_KEY"
node .\scripts\update-data.js
```

## 출력 형식

스크립트는 `data.json`을 아래 포맷으로 갱신합니다.

```json
{
  "as_of": "2026-03-27",
  "generated_at": "2026-03-27T00:00:00.000Z",
  "data_source": "Financial Modeling Prep API v3",
  "record_count": 500,
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
