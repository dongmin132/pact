---
description: architect 호출 — API/DB/모듈 계약 정의 + TBD 마커 해소
---

사용자가 `/pact:contracts`를 실행했습니다.

## 단계 1: 사전 검사

1. `CLAUDE.md` 존재 — 없으면 "/pact:init 먼저" 후 중단
2. `TASKS.md` 존재 — 없으면 "/pact:plan 먼저" 후 중단
3. **머지 진행 중 X**:
   ```bash
   git rev-parse -q --verify MERGE_HEAD
   ```
   exit 0이면 "이전 머지 충돌 미해결" 안내 후 중단

## 단계 2: 계약 템플릿 복사 (없을 때만)

다음 파일이 현재 디렉토리에 없으면 templates에서 복사:

```bash
for f in API_CONTRACT.md MODULE_OWNERSHIP.md DB_CONTRACT.md; do
  if [ ! -f "$f" ]; then
    cp "${CLAUDE_PLUGIN_ROOT}/templates/$f" "$f"
  fi
done
```

이미 있으면 그대로 둠 (architect가 갱신).

## 단계 3: architect 서브에이전트 호출

Task tool로 `architect` 호출:

- `subagent_type`: `architect`
- `description`: "계약 정의 — TBD 해소 + cycle 검증"
- `prompt`:
  ```
  TASKS.md의 TBD 마커를 모두 해소하고 API_CONTRACT.md / MODULE_OWNERSHIP.md / DB_CONTRACT.md를 생성·갱신해주세요.
  
  종료 조건:
  1. TASKS.md TBD 마커 0개
  2. 모든 task의 allowed_paths가 MODULE_OWNERSHIP.md 모듈 안에 들어감
  3. 의존성 cycle 0개
  4. API endpoint와 DB table은 시그니처만, 구현 X
  
  비즈니스 결정이 필요하면 사용자에게 위임. 추측 X.
  ```

## 단계 4: 결과 확인

architect 종료 후:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/parse-tasks.js TASKS.md
```

`tbdMarkers` 배열이 비어있어야 정상.

## 단계 5: 결과 보고 (한국어)

### 성공
```
✅ 계약 정의 완료

해소된 TBD: <N>개
정의된 endpoint: <M>개 (API_CONTRACT.md)
정의된 module: <K>개 (MODULE_OWNERSHIP.md)

다음 단계:
  /pact:plan-arch-review     # 아키텍처 + 계약 정합성 검토
  /pact:plan-ui-review       # UI 디자인 (UI task 있을 때)
  /pact:cross-review-plan    # 외부 의견 (Codex, P2.5)
  /pact:parallel             # 워커 spawn
```

### TBD 잔존
```
⚠️ TBD 일부 미해소

남은 TBD: <N>개
  - <task_id>.<field>

architect가 비즈니스 결정 필요 시 사용자에게 위임했을 가능성. DECISIONS.md 확인.
```

## 의문 시

- 계약 파일 사용자가 직접 수정 후 contracts 재실행: architect가 기존 내용 보존하며 갱신 (덮어쓰기 X)
- cycle 발견: architect가 사용자에게 보고, /pact:plan으로 task 재분해 권장
