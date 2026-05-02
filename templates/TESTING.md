# 테스트 정책 — <project-name>

> 테스트 전략·커버리지·도구·CI 설정의 영구 기록.
> 사용자가 정책 변경 시 직접 갱신.
> reviewer·워커(TDD)가 매번 lazy-load.

---

## 1. 테스트 종류

```yaml
unit:
  framework: <jest | vitest | node:test | ...>
  location: <colocated | __tests__/ | tests/>
  scope: <함수·클래스 단위>
integration:
  framework: <...>
  scope: <DB·외부 서비스 stub 포함>
e2e:
  framework: <playwright | cypress | ...>
  scope: <브라우저·실제 인프라>
```

## 2. TDD 정책

```yaml
default: ON       # 비즈니스 로직 task 기본 ON
opt_out_for:      # tdd: false 허용 task 종류
  - 마크다운 작성
  - 설정 파일
  - 마이그레이션
  - 문서 업데이트
red_observed_required: true   # tdd_evidence 거짓 시 작업 무효
```

## 3. 커버리지 목표

```yaml
unit: 80
integration: 60
critical_paths: 100   # auth·결제 등
```

## 4. mock·fixture 정책

- 외부 서비스: mock 사용
- DB: integration test에서 실제 DB (mock X — 마이그레이션 검증 가능)
- LLM API: mock 사용 (비용·결정성)

## 5. CI 설정

```yaml
on_push:
  - lint
  - typecheck
  - unit test
on_pr:
  - integration test
  - e2e test (smoke)
on_main:
  - full e2e
  - canary deploy
```

## 6. 테스트 안티패턴

이 프로젝트에서 금지:

- ❌ <안티패턴 1 — 예: "DB mock으로 마이그레이션 검증 우회">
- ❌ <안티패턴 2>
