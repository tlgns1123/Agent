/**
 * OH — 할일/계획 추적 (TodoWrite 류)
 *
 * 멀티스텝 작업에서 모델이 계획을 세우고 진행상태를 갱신하도록 한다.
 * 상용 코딩 에이전트(Claude Code 등)의 TodoWrite 와 같은 역할:
 *   - 모델에게: 긴 작업을 단계로 쪼개 "지금 뭘 하는 중인지" 스스로 추적(집중 유지).
 *   - 사용자에게: 진행 현황을 체크리스트로 가시화.
 *
 * 상태는 모듈 전역 1개(세션/턴 공용). 매 유저 턴 시작 시 clearTodos()로 초기화한다.
 * executeTool 경로(프로덕션·eval 공용)에서 state 없이도 쓰도록 모듈 전역으로 둔다.
 */

const STATUSES = ['pending', 'in_progress', 'completed'];

let _todos = [];

/** 전체 목록을 교체(모델은 매번 전체 리스트를 보낸다 — 부분 패치 아님). */
export function setTodos(items) {
  const list = Array.isArray(items) ? items : [];
  _todos = list
    .map((t, i) => ({
      id: Number.isInteger(t?.id) ? t.id : i + 1,
      content: String(t?.content ?? t?.task ?? t?.title ?? '').trim().slice(0, 300),
      status: STATUSES.includes(t?.status) ? t.status : 'pending',
    }))
    .filter((t) => t.content);
  return _todos;
}

export function getTodos() { return _todos; }
export function clearTodos() { _todos = []; }

/** 진행 요약: {total, done, doing, pending}. */
export function todoSummary() {
  return {
    total: _todos.length,
    done: _todos.filter((t) => t.status === 'completed').length,
    doing: _todos.filter((t) => t.status === 'in_progress').length,
    pending: _todos.filter((t) => t.status === 'pending').length,
  };
}
