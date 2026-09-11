(function () {
  'use strict';
  if (window.__uooAuto) { window.__uooAuto.show(); return; }

  var LS_KEY = 'uoo_auto_v1';
  var state = {
    engine: 'idle',
    queue: [],
    idx: 0,
    rate: 8,
    mute: true,
    done: {},
    log: [],
    current: null,
    sweep: 0
  };
  try { var saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}'); if (saved.done) state.done = saved.done; } catch (e) {}
  function save() { try { localStorage.setItem(LS_KEY, JSON.stringify({ done: state.done })); } catch (e) {} }

  var m = location.hash.match(/#\/(\d{6,})/);
  var CID = m ? m[1] : null;
  if (!CID) { alert('请先进入课程学习页面再运行本脚本'); return; }

  var api = {
    show: show, start: start, pause: pause, stop: stop, refresh: refreshAll, sweep: sweepNow,
    playOne: function (i) { if (state.engine === 'idle' || state.engine === 'paused') { state.queue = state.videos.slice(); state.idx = i; run(); } }
  };
  window.__uooAuto = api;

  function log(s) {
    state.log.push('[' + new Date().toLocaleTimeString() + '] ' + s);
    if (state.log.length > 200) state.log.shift();
    render();
  }
  function fetchJSON(url) {
    return fetch(url, { credentials: 'include' }).then(function (r) { return r.json(); });
  }
  function sectionURL(ch, sec) {
    return '/home/learn/getUnitLearn?catalog_id=' + sec + '&chapter_id=' + ch + '&cid=' + CID + '&hidemsg_=true&section_id=' + sec + '&show=';
  }

  function refreshAll() {
    if (!state.videos) return Promise.resolve();
    var n = 0;
    log('刷新完成状态中...');
    function next(k) {
      if (k >= state.videos.length) { log('状态刷新完毕'); render(); return Promise.resolve(); }
      var v = state.videos[k];
      return fetchJSON(sectionURL(v.ch, v.sec)).then(function (d) {
        (d.data || []).forEach(function (s) {
          if (String(s.id) === String(v.id)) v.finished = s.finished;
        });
        n++;
        if (n % 10 === 0) render();
        return next(k + 1);
      }).catch(function () { return next(k + 1); });
    }
    return next(0);
  }

  function fetchVideos() {
    log('获取课程视频列表...');
    return fetchJSON('/home/learn/getCatalog?cid=' + CID).catch(function () { return null; }).then(function (cat) {
      var el = document.querySelector('li.catalogItem');
      var node = el && window.angular ? angular.element(el).scope() : null, list = null;
      for (var i = 0; i < 8 && node; i++) { if (node.chapterList) { list = node.chapterList; break; } node = node.$parent; }
      if (!list) throw new Error('拿不到章节列表，请在学习页运行');
      var jobs = [];
      list.forEach(function (ch) { (ch.children || []).forEach(function (sec) { jobs.push({ ch: ch.id, sec: sec.id, num: sec.number, name: (sec.name || '').trim() }); }); });
      var out = [];
      function next(k) {
        if (k >= jobs.length) { log('共获取 ' + out.length + ' 个视频'); return Promise.resolve(out); }
        var j = jobs[k];
        return fetchJSON(sectionURL(j.ch, j.sec)).then(function (d) {
          (d.data || []).forEach(function (s) {
            if (String(s.type) === '10') {
              out.push({ ch: j.ch, sec: j.sec, secNum: j.num, secName: j.name, id: s.id, title: (s.title || '').trim(), is_task: s.is_task, finished: s.finished, dur: null });
            }
          });
          if (k % 10 === 0) { log('已获取 ' + out.length + ' 个视频...'); }
          return next(k + 1);
        }).catch(function () { return next(k + 1); });
      }
      return next(0);
    });
  }

  function navigate(v) {
    location.hash = '#/' + CID + '/' + v.ch + '/' + v.sec + '/' + v.id + '/section';
  }
  function waitForVideo(timeout) {
    var t0 = Date.now();
    return new Promise(function (res) {
      (function poll() {
        var v = document.querySelector('video');
        if (v && (v.src || v.currentSrc)) return res(v);
        if (Date.now() - t0 > timeout) return res(null);
        setTimeout(poll, 500);
      })();
    });
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  var tick = { timer: null, lastT: -1, stall: 0, retries: 0 };

  function assertPlay(v) {
    if (state.rate && Math.abs(v.playbackRate - state.rate) > 0.01) { try { v.playbackRate = state.rate; } catch (e) {} }
    if (state.mute && !v.muted) v.muted = true;
    if (v.paused) { var p = v.play(); if (p && p.catch) p.catch(function () {}); }
  }

  function playLoop(v, meta) {
    return new Promise(function (resolve) {
      clearInterval(tick.timer);
      tick.lastT = -1; tick.stall = 0; tick.pass = 0; tick.vc = 0; tick.busy = false;
      log('第 1 遍播放 ' + meta.secNum);
      function tryVerify() {
        if (tick.busy) return;
        tick.busy = true;
        verifyDone(meta).then(function (ok) {
          tick.busy = false;
          if (ok) { clearInterval(tick.timer); resolve('confirmed'); }
        }).catch(function () { tick.busy = false; });
      }
      tick.timer = setInterval(function () {
        if (state.engine === 'paused') return;
        if (state.engine === 'stopping') { clearInterval(tick.timer); try { v.pause(); } catch (e) {} resolve('stopped'); return; }
        if (!v.isConnected) { clearInterval(tick.timer); resolve('lost'); return; }
        assertPlay(v);
        meta.dur = v.duration || meta.dur;
        var t = v.currentTime;
        if (tick.lastT > 10 && t < tick.lastT - 30) {
          tick.pass++;
          if (tick.pass >= 10) { log('重播 ' + tick.pass + ' 遍仍未确认，跳过 ' + meta.secNum); clearInterval(tick.timer); resolve('gaveup'); return; }
          log('平台自动重播，第 ' + (tick.pass + 1) + ' 遍 ' + meta.secNum);
          tryVerify();
        }
        if (Math.abs(t - tick.lastT) < 0.05 && !v.ended) { tick.stall++; } else { tick.stall = 0; }
        tick.lastT = t;
        if (tick.stall >= 10 && !v.ended) {
          clearInterval(tick.timer);
          tick.retries++;
          if (tick.retries <= 2) { log('播放停滞，重试 ' + meta.secNum); try { v.currentTime = Math.max(0, v.duration - 30); } catch (e) {} v.play(); playLoop(v, meta).then(resolve); }
          else { log('多次停滞，跳过 ' + meta.secNum); resolve('stalled'); }
          return;
        }
        tick.vc++;
        if (v.ended || t >= v.duration - 0.6 || tick.vc >= 20) { tick.vc = 0; tryVerify(); }
      }, 1000);
    });
  }

  function verifyDone(v) {
    return fetchJSON(sectionURL(v.ch, v.sec)).then(function (d) {
      var f = null;
      (d.data || []).forEach(function (s) { if (String(s.id) === String(v.id)) f = s.finished; });
      return String(f) === '1';
    }).catch(function () { return false; });
  }

  function run() {
    state.engine = 'running';
    function next() {
      if (state.engine === 'stopping') { state.engine = 'idle'; log('已停止'); render(); return; }
      if (state.idx >= state.queue.length) { sweepNow(); return; }
      var v = state.queue[state.idx];
      state.current = v;
      log('▶ ' + v.secNum + ' ' + v.secName + ' (' + (state.idx + 1) + '/' + state.queue.length + ')');
      render();
      navigate(v);
      sleep(2500).then(function () { return waitForVideo(25000); }).then(function (el) {
        if (!el) { log('播放器加载失败，跳过 ' + v.secNum); state.idx++; return sleep(1500).then(next); }
        return playLoop(el, v).then(function (how) {
          if (how === 'stopped') return;
          if (how === 'confirmed') {
            log('✔ 服务端确认完成 ' + v.secNum);
            state.done[v.id] = true; v.finished = 1; save();
          }
          state.idx++;
          return sleep(1200).then(next);
        });
      }).catch(function (e) { log('出错: ' + e.message + '，跳过'); state.idx++; return sleep(1200).then(next); });
    }
    next();
  }

  function start() {
    if (state.engine === 'running') return;
    tick.retries = 0;
    if (state.videos) {
      if (state.idx < state.queue.length && state.engine === 'paused') { state.engine = 'running'; log('继续'); render(); return; }
      state.queue = state.videos.slice().filter(function (v) { return String(v.finished) !== '1'; });
      state.idx = 0;
      if (!state.queue.length) { log('全部任务点已完成，执行复核'); return sweepNow(); }
      run();
    } else {
      fetchVideos().then(function (vs) {
        state.videos = vs;
        state.queue = vs.slice().filter(function (v) { return String(v.finished) !== '1' && !state.done[v.id]; });
        state.idx = 0;
        if (!state.queue.length) { log('全部任务点已完成，执行复核'); return sweepNow(); }
        run();
      }).catch(function (e) { log('初始化失败: ' + e.message); });
    }
  }
  function pause() { if (state.engine === 'running') { state.engine = 'paused'; var v = document.querySelector('video'); if (v) v.pause(); log('已暂停'); render(); } }
  function stop() { state.engine = 'stopping'; log('停止中...'); render(); }

  function sweepNow() {
    if (!state.videos) { log('请先点开始获取列表'); return; }
    state.engine = 'sweeping';
    log('第 ' + (++state.sweep) + ' 次复核完成度...');
    refreshAll().then(function () {
      var left = state.videos.filter(function (v) { return String(v.is_task) === '1' && String(v.finished) !== '1' && !state.done[v.id]; });
      if (!left.length) {
        left = state.videos.filter(function (v) { return String(v.is_task) === '1' && String(v.finished) !== '1'; });
      }
      if (!left.length) { state.engine = 'idle'; log('🎉 全部视频完成度 100%，自动停止'); state.current = null; render(); return; }
      if (state.sweep > 3) { state.engine = 'idle'; log('复核 3 次仍有 ' + left.length + ' 个未完成，已停止，请手动检查'); render(); return; }
      log('发现 ' + left.length + ' 个未完成，重新播放');
      state.queue = left; state.idx = 0;
      sleep(1000).then(run);
    });
  }

  function show() { panel.style.display = 'block'; render(); }

  var panel = document.createElement('div');
  panel.innerHTML =
    '<div id="uooBar" style="cursor:move;background:linear-gradient(90deg,#4f7cff,#7a4fff);color:#fff;padding:7px 10px;font:bold 13px sans-serif;display:flex;justify-content:space-between;align-items:center">' +
    '<span>优课自动刷课</span><span id="uooMin" style="cursor:pointer">—</span></div>' +
    '<div id="uooBody" style="padding:10px">' +
    '<div id="uooStat" style="font:12px/1.6 sans-serif;color:#eee;margin-bottom:6px">待初始化</div>' +
    '<div style="background:#333;height:8px;border-radius:4px;overflow:hidden;margin-bottom:8px"><div id="uooProg" style="height:100%;width:0;background:#4f7cff"></div></div>' +
    '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">' +
    '<button id="uooStart" style="flex:1;padding:5px;background:#2ecc71;border:0;border-radius:4px;color:#fff;cursor:pointer">开始</button>' +
    '<button id="uooPause" style="flex:1;padding:5px;background:#f39c12;border:0;border-radius:4px;color:#fff;cursor:pointer">暂停</button>' +
    '<button id="uooStop" style="flex:1;padding:5px;background:#e74c3c;border:0;border-radius:4px;color:#fff;cursor:pointer">停止</button>' +
    '</div>' +
    '<div style="display:flex;gap:6px;align-items:center;margin-bottom:8px;font:12px sans-serif;color:#eee">' +
    '倍速 <select id="uooRate" style="background:#333;color:#fff;border:1px solid #555;border-radius:4px;padding:3px">' +
    [2, 4, 8, 10, 12, 16].map(function (r) { return '<option value="' + r + '"' + (r === 8 ? ' selected' : '') + '>' + r + 'x</option>'; }).join('') +
    '</select>' +
    '<label style="display:flex;align-items:center;gap:3px;cursor:pointer"><input type="checkbox" id="uooMute" checked>静音</label>' +
    '<button id="uooRefresh" style="padding:4px 8px;background:#555;border:0;border-radius:4px;color:#fff;cursor:pointer">刷新状态</button>' +
    '</div>' +
    '<div id="uooLog" style="font:11px/1.5 monospace;color:#9f9;background:#222;border-radius:4px;padding:6px;height:84px;overflow-y:auto;margin-bottom:8px;white-space:pre-wrap"></div>' +
    '<div id="uooList" style="font:11px/1.7 monospace;color:#ddd;background:#222;border-radius:4px;padding:6px;height:150px;overflow-y:auto"></div>' +
    '</div>';
  panel.style.cssText = 'position:fixed;top:70px;right:20px;width:330px;background:rgba(24,26,32,.96);border:1px solid #444;border-radius:10px;z-index:2147483647;box-shadow:0 8px 30px rgba(0,0,0,.5);display:none';
  document.body.appendChild(panel);

  var bar = panel.querySelector('#uooBar');
  bar.onmousedown = function (e) {
    if (e.target.id === 'uooMin') return;
    var sx = e.clientX - panel.offsetLeft, sy = e.clientY - panel.offsetTop;
    function mv(ev) { panel.style.left = (ev.clientX - sx) + 'px'; panel.style.top = (ev.clientY - sy) + 'px'; panel.style.right = 'auto'; }
    function up() { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); }
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
  };
  var minned = false;
  panel.querySelector('#uooMin').onclick = function () {
    minned = !minned;
    panel.querySelector('#uooBody').style.display = minned ? 'none' : 'block';
  };
  panel.querySelector('#uooStart').onclick = start;
  panel.querySelector('#uooPause').onclick = pause;
  panel.querySelector('#uooStop').onclick = stop;
  panel.querySelector('#uooRefresh').onclick = function () { refreshAll().then(render); };
  panel.querySelector('#uooRate').onchange = function (e) { state.rate = +e.target.value; log('倍速设为 ' + state.rate + 'x'); };
  panel.querySelector('#uooMute').onchange = function (e) { state.mute = e.target.checked; };

  function render() {
    var stat = panel.querySelector('#uooStat'), prog = panel.querySelector('#uooProg'),
        logEl = panel.querySelector('#uooLog'), listEl = panel.querySelector('#uooList');
    if (state.videos) {
      var fin = state.videos.filter(function (v) { return String(v.finished) === '1' || state.done[v.id]; }).length;
      var cur = state.current ? state.current.secNum + ' ' + state.current.secName : '—';
      stat.innerHTML = '<b style="color:#7ab7ff">' + state.engine.toUpperCase() + '</b> | 当前: ' + cur +
        '<br>进度: ' + fin + ' / ' + state.videos.length + ' 个视频完成';
      prog.style.width = (fin / state.videos.length * 100).toFixed(1) + '%';
      listEl.innerHTML = state.videos.map(function (v, i) {
        var ok = String(v.finished) === '1' || state.done[v.id];
        var curMark = state.current && state.current.id === v.id ? ' ▶' : '';
        var d = v.dur ? ' ' + Math.round(v.dur / 60) + 'min' : '';
        return '<div data-i="' + i + '" style="cursor:pointer;color:' + (ok ? '#5f5' : '#ddd') + '">' +
          (ok ? '✔' : '·') + ' ' + v.secNum + ' ' + v.secName.slice(0, 22) + d + curMark + '</div>';
      }).join('');
      listEl.querySelectorAll('[data-i]').forEach(function (el) {
        el.onclick = function () { api.playOne(+el.getAttribute('data-i')); };
      });
    } else {
      stat.innerHTML = '<b style="color:#7ab7ff">' + state.engine.toUpperCase() + '</b> | 点「开始」获取视频列表并自动播放';
    }
    logEl.innerHTML = state.log.slice(-40).join('\n');
    logEl.scrollTop = logEl.scrollHeight;
  }
  setInterval(function () { if (panel.style.display !== 'none') render(); }, 3000);

  log('脚本已加载，CID=' + CID + '，点「开始」运行');
  show();
})();
