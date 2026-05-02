# DECISIONS — <project-name>

> ADR (Architecture Decision Record) 누적.
> 결정·발견·정책 변경을 박는다. 코드와 PR 메시지에는 안 박히는 "왜" 정보의 영구 보관소.

---

## 사용 가이드

- 새 결정마다 ADR-NNN 번호 + 제목
- 폐기된 결정도 삭제 X — **상태**를 "폐기"로 변경, 새 ADR이 대체
- 매니저(planner·architect·reviewer)는 의사결정 시 이 파일 lazy-load

---

## ADR 템플릿 (복붙용)

```markdown
## ADR-NNN — <한 줄 결정 제목>

- **상태**: 채택 | 폐기 | 변경됨
- **날짜**: YYYY-MM-DD
- **출처**: <PACT-XXX, 사용자 토론, cross-review 등>
- **관련**: <ARCHITECTURE.md §X, 다른 ADR>

### 발견 / 배경

<무엇을 알게 되었는가, 왜 결정이 필요한가>

### 결정

<무엇으로 가기로 했는가>

### 트레이드오프

- ❌ <단점 1>
- ❌ <단점 2>
- ✅ <장점 1>
- ✅ <장점 2>
```

---

## ADR-001  <첫 결정>

- **상태**: 채택
- **날짜**: <YYYY-MM-DD>
- **출처**: <레퍼런스>
- **관련**: <ARCHITECTURE.md §X>

### 발견 / 배경

<설명>

### 결정

<설명>

### 트레이드오프

- ❌ <단점>
- ✅ <장점>
