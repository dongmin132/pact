# <project-name> Architecture

> 시스템 설계의 영구 기록.
> 큰 변경 시 사용자가 직접 갱신.
> 매니저(planner·architect·reviewer)가 매번 lazy-load.

---

## 1. 시스템 개요

<프로젝트가 어떤 시스템인지 한 단락>

## 2. 주요 컴포넌트

```
[클라이언트] ──── [API 서버] ──── [DB]
                      │
                      └─── [외부 서비스 X, Y]
```

(다이어그램·prose로 컴포넌트 관계 설명)

## 3. 데이터 흐름

<주요 use case별로 데이터가 어떻게 흐르는지>

## 4. 핵심 결정 사항

ARCHITECTURE.md는 결정의 누적 기록. 각 결정은 다음 형식:

```yaml
decision: <한 줄 결정>
date: YYYY-MM-DD
rationale: <왜>
trade_off: <단점>
```

(중요 결정만 ARCHITECTURE.md에. 사소한 결정은 DECISIONS.md.)

## 5. 외부 의존성

```yaml
runtime:
  - <name>: <version> — <용도>
build_tools:
  - <name>
external_services:
  - <name>: <엔드포인트>
```

## 6. 알려진 한계

- <한계 1>
- <한계 2>
