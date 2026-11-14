/* 审计脚本会临时切到离线预览；结束时把本机配置恢复为需求指定的真实来源 */
(async () => {
  persistConn({ source: 'model', api: { ...DEFAULT_API }, verified: true });
  return { source: sourceOf(), baseUrl: document.querySelector('#apiBaseUrl').value, model: MODEL_ID };
})();
