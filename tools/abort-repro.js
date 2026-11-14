/* 真实 API 复现：流式进行中点击停止按钮，检查状态是否立即恢复 */
(async () => {
  const q = (s) => document.querySelector(s);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const prose = () => [...document.querySelectorAll('.prose')].at(-1)?.textContent.length ?? -1;
  newChat();
  const ta = q('#input');
  ta.value = '请写一篇 1500 字的长文章，分多段逐步输出，不要省略';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  q('#sendBtn').click();
  await sleep(3500);
  const before = { busy: state.busy, turn: state.activeTurnId, chars: prose(), btn: q('#sendBtn').className };
  q('#sendBtn').click();
  await sleep(1500);
  const after1 = { busy: state.busy, turn: state.activeTurnId, chars: prose(), summary: [...document.querySelectorAll('.summary')].at(-1)?.textContent.trim() };
  await sleep(3000);
  const after2 = { busy: state.busy, turn: state.activeTurnId, chars: prose(), summary: [...document.querySelectorAll('.summary')].at(-1)?.textContent.trim() };
  return { before, after1, after2 };
})();
