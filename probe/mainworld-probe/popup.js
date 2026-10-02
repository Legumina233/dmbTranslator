function refresh() {
  chrome.runtime.sendMessage({ type: 'count' }, (r) => {
    document.getElementById('count').textContent = r ? r.count : '?';
  });
}
document.getElementById('refresh').addEventListener('click', refresh);
document.getElementById('clear').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'clear' }, refresh);
});
document.getElementById('export').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'export' }, (r) => {
    if (r && r.ok) document.getElementById('count').textContent = r.events;
  });
});
refresh();
