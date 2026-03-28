# S&P 500 데이터 갱신 가이드 (무료 파이프라인)

`scripts/update-data.js`는 **유료 시장 API 없이** `data.json`을 만듭니다.

## 데이터 출처

| 항목 | 출처 |
|------|------|
| S&P 500 구성·섹터 | DataHub CSV (미러: GitHub raw) |
| 주가·시가총액·52주 변동% | Yahoo 비공식 quote(가능할 때) → **401 등이면 Stooq 종가 + SEC 발행주식수로 시총 추정** |
| TTM 매출·순이익 | SEC EDGAR `companyfacts` (분기 XBRL, 최근 4분기 합산) |

**주의:** Yahoo는 공식 API가 아니며, 차단·응답 변경 가능성이 있습니다. SEC는 [접근 정책](https://www.sec.gov/os/accessing-edgar-data)에 따라 **식별 가능한 User-Agent(연락처 포함)**가 필요합니다.

## 준비

1. Node.js 18+
2. 프로젝트 루트에 `.env` 생성 (`.env.example` 참고)

필수:

```env
SEC_CONTACT_EMAIL=
```

## 실행

```powershell
node .\scripts\update-data.js
```

## GitHub Actions

Repository **Variables**에 다음을 설정하세요.

- `SEC_CONTACT_EMAIL` — SEC 정책용 공개 연락처(이메일). 민감하면 전용 이메일 사용.
- `CONSTITUENTS_CSV_URLS` (선택) — 쉼표로 구분된 CSV URL 목록

Secrets는 Supabase 업로드 단계만 사용합니다 (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, bucket/path 변수).

## 출력 형식

`index.html`이 기대하는 필드: `symbol`, `name`, `sector`, `ttm_revenue_b`, `ttm_net_income_b`, `market_cap_b`, `price_change_pct`, `price`, `profit_margin`.

최상위 메타: `as_of`, `generated_at`, `data_source`, `record_count`, `data`.

## 문제 해결

- **Yahoo 시총이 거의 비어 있음:** 나중에 재시도하거나 `YAHOO_USER_AGENT` 조정(환경변수).
- **SEC 403:** `SEC_CONTACT_EMAIL` / `SEC_USER_AGENT` 확인.
- **일부 종목 재무 0:** 해당 기업의 XBRL 태그가 목록에 없을 수 있음(은행·보험 등은 다른 지표 사용 가능).
