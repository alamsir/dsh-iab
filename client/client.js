/**
 * dsh-iab — client half.
 *
 * Mirrors the Host-owned Chromium as a live panel: an SSE screencast feed drawn
 * into an <img>, with pointer/key events forwarded back through the Host. It
 * registers a right-sidebar tab type so the browser lives next to the session
 * (the same place the built-in Browser tab lives) instead of in an iframe.
 */
window.__ModuleLoader__.load({
  id: 'dsh-iab',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'dshIab';
    const TAB_ID = 'dsh-iab-browser';
    const TAB_KIND = 'dsh-iab';

    const zh = {
      title: '内置浏览器',
      guide: '打开浏览器',
      guideHint: '在 DSH 内浏览网页，登录一次长期有效',
      loading: '正在连接浏览器…',
      start: '启动浏览器',
      address: '输入网址',
      go: '前往',
      reload: '刷新',
      offline: '浏览器未启动',
      error: '浏览器连接失败',
      tabList: '标签页',
      closeTab: '关闭',
      newTab: '新建标签页',
    };
    const en = {
      title: 'In-app browser',
      guide: 'Open browser',
      guideHint: 'Browse inside DSH; one login lasts across restarts',
      loading: 'Connecting to the browser…',
      start: 'Start browser',
      address: 'Enter a URL',
      go: 'Go',
      reload: 'Reload',
      offline: 'Browser is not running',
      error: 'Browser connection failed',
      tabList: 'Tabs',
      closeTab: 'Close',
      newTab: 'New tab',
    };

    const STYLE_ID = 'dsh-iab-style';
    function ensureStyles() {
      if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = `
.dsh-iab-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base,#fff)}
.dsh-iab-bar{display:flex;gap:6px;align-items:center;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-base,#e5e6eb);flex:0 0 auto}
.dsh-iab-bar input{flex:1 1 auto;min-width:0;height:26px;padding:0 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-base,#e5e6eb);background:var(--dsw-alias-bg-base,#fff);color:inherit;font-size:12px}
.dsh-iab-bar button{height:26px;padding:0 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-base,#e5e6eb);background:var(--dsw-alias-bg-float,#f7f8fa);color:inherit;font-size:12px;cursor:pointer}
.dsh-iab-bar button:hover{background:var(--dsw-alias-bg-hover,#eef0f3)}
.dsh-iab-view{position:relative;flex:1 1 auto;min-height:0;overflow:hidden;background:#fff;display:flex;align-items:flex-start;justify-content:center}
.dsh-iab-view img{display:block;max-width:100%;max-height:100%;object-fit:contain;cursor:default;user-select:none;-webkit-user-drag:none}
.dsh-iab-hint{padding:24px;color:var(--dsw-alias-text-secondary,#646a73);font-size:13px;line-height:1.7;text-align:center}
.dsh-iab-hint button{margin-top:12px;height:28px;padding:0 14px;border-radius:6px;border:1px solid var(--dsw-alias-border-base,#e5e6eb);background:var(--dsw-alias-bg-float,#f7f8fa);color:inherit;cursor:pointer}
.dsh-iab-tabs{display:flex;gap:4px;padding:4px 8px;border-bottom:1px solid var(--dsw-alias-border-base,#e5e6eb);overflow-x:auto;flex:0 0 auto}
.dsh-iab-tabs span{font-size:11px;padding:2px 8px;border-radius:10px;background:var(--dsw-alias-bg-float,#f2f3f5);white-space:nowrap;cursor:pointer}
`;
      document.head.appendChild(style);
    }

    /** POST a JSON command to the Host. */
    async function api(path, body, method = 'POST') {
      const res = await fetch(`/dsh-iab/api${path}`, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    }

    function BrowserPanel() {
      const [status, setStatus] = React.useState({ loading: true });
      const [tabId, setTabId] = React.useState(undefined);
      const [address, setAddress] = React.useState('');
      const [frame, setFrame] = React.useState(null);
      const [error, setError] = React.useState(null);
      const imgRef = React.useRef(null);
      // Set once the user clicks a tab chip. Until then the panel follows whatever
      // the Host last navigated, which is what a tool-triggered open expects.
      const pinned = React.useRef(false);

      const refresh = React.useCallback(async () => {
        try {
          const data = await api('/status', undefined, 'GET');
          setStatus({ ...data, loading: false });
          const list = data.tabs || [];
          // Follow the Host unless the user is driving. `tabs[0]` is a trap: it is
          // usually the blank tab Chromium opens for itself, so a tool-triggered
          // navigation would appear to do nothing.
          const wanted = pinned.current ? tabId : (data.activeTabId ?? tabId);
          const current = list.find((t) => t.tabId === wanted) || list[0];
          if (current && current.tabId !== tabId) setTabId(current.tabId);
          if (current && current.url && current.url !== address) setAddress(current.url);
        } catch (e) {
          setStatus({ loading: false, running: false });
          setError(String(e.message || e));
        }
      }, [tabId, address]);

      React.useEffect(() => {
        ensureStyles();
        void refresh();
      }, [refresh]);

      // React to the Host, not just to mount. A tool can start Chromium while this
      // panel is already on screen; without a subscription it would keep showing
      // "browser is not running" forever. `keepMounted` makes that failure mode
      // the normal case, so this is not an optimisation.
      React.useEffect(() => {
        const source = new EventSource('/dsh-iab/api/events');
        source.onmessage = (message) => {
          let payload;
          try {
            payload = JSON.parse(message.data);
          } catch {
            return;
          }
          if (payload?.type === 'state' || payload?.type === 'reveal') void refresh();
        };
        source.onerror = () => {
          /* EventSource retries on its own */
        };
        return () => source.close();
      }, [refresh]);

      // Keep the panel in step with the Host. Events give an immediate reaction;
      // this poll covers everything else (a second tool call, a tab opened from
      // the agent, the browser dying) — a loopback request every 2.5 s is cheap,
      // and without it the panel silently freezes on whatever it saw first.
      React.useEffect(() => {
        const timer = setInterval(() => void refresh(), 2500);
        return () => clearInterval(timer);
      }, [refresh]);

      // Live frame feed: one SSE stream per tab.
      React.useEffect(() => {
        if (!status.running) return undefined;
        const query = tabId ? `?tabId=${encodeURIComponent(tabId)}` : '';
        const source = new EventSource(`/dsh-iab/api/stream${query}`);
        source.onmessage = (event) => {
          try {
            const payload = JSON.parse(event.data);
            setFrame(`data:image/jpeg;base64,${payload.data}`);
          } catch {
            /* ignore a malformed frame */
          }
        };
        source.onerror = () => source.close();
        return () => source.close();
      }, [status.running, tabId]);

      const scale = () => {
        const img = imgRef.current;
        if (!img) return 1;
        const natural = img.naturalWidth || 1;
        return (img.clientWidth || natural) / natural;
      };

      const pointer = (action) => (event) => {
        if (!status.running) return;
        const img = imgRef.current;
        if (!img) return;
        const rect = img.getBoundingClientRect();
        const imageScale = scale();
        const x = (event.clientX - rect.left) / imageScale;
        const y = (event.clientY - rect.top) / imageScale;
        void api('/input', {
          tabId,
          type: 'mouse',
          action,
          x,
          y,
          button: event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left',
          modifiers: (event.shiftKey ? 8 : 0) | (event.ctrlKey ? 2 : 0) | (event.altKey ? 1 : 0) | (event.metaKey ? 4 : 0),
        }).catch(() => {});
      };

      const wheel = (event) => {
        if (!status.running) return;
        event.preventDefault();
        const img = imgRef.current;
        if (!img) return;
        const rect = img.getBoundingClientRect();
        const imageScale = scale();
        void api('/input', {
          tabId,
          type: 'wheel',
          x: (event.clientX - rect.left) / imageScale,
          y: (event.clientY - rect.top) / imageScale,
          deltaX: event.deltaX,
          deltaY: event.deltaY,
        }).catch(() => {});
      };

      const keyDown = (event) => {
        if (!status.running) return;
        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
          void api('/input', { tabId, type: 'key', action: 'char', key: event.key }).catch(() => {});
          return;
        }
        void api('/input', {
          tabId,
          type: 'key',
          action: 'down',
          key: event.key,
          code: event.code,
          keyCode: event.keyCode,
          modifiers: (event.shiftKey ? 8 : 0) | (event.ctrlKey ? 2 : 0) | (event.altKey ? 1 : 0) | (event.metaKey ? 4 : 0),
        }).catch(() => {});
      };

      const go = (event) => {
        event?.preventDefault?.();
        if (!address) return;
        const url = /^https?:\/\//i.test(address) ? address : `https://${address}`;
        void api('/open', { url }).then((opened) => {
          setTabId(opened.tabId);
          setAddress(opened.url || url);
        }).catch((e) => setError(String(e.message || e)));
      };

      const start = () => {
        setError(null);
        void api('/start', {}).then(() => refresh()).catch((e) => setError(String(e.message || e)));
      };

      if (status.loading) return h('div', { className: 'dsh-iab-root' }, h('div', { className: 'dsh-iab-hint' }, zh.loading));
      if (!status.running) {
        return h('div', { className: 'dsh-iab-root' },
          h('div', { className: 'dsh-iab-hint' },
            h('div', null, zh.offline),
            h('div', { style: { fontSize: 11, opacity: 0.75 } }, status.profile || ''),
            h('button', { onClick: start }, zh.start),
            error ? h('div', { style: { color: '#d54941', marginTop: 8 } }, error) : null));
      }

      return h('div', { className: 'dsh-iab-root' },
        h('div', { className: 'dsh-iab-tabs' },
          (status.tabs || []).map((t) => h('span', {
            key: t.tabId,
            onClick: () => { pinned.current = true; setTabId(t.tabId); },
            style: t.tabId === tabId ? { background: 'var(--dsw-alias-bg-hover,#e8f3ff)' } : undefined,
            title: t.url,
          }, t.title || t.url || t.tabId))),
        h('div', { className: 'dsh-iab-bar' },
          h('button', { onClick: () => { void api('/navigate', { tabId, url: address }).then(() => refresh()); } }, zh.reload),
          h('form', { onSubmit: go, style: { display: 'flex', flex: '1 1 auto', gap: 6 } },
            h('input', {
              value: address,
              placeholder: zh.address,
              onChange: (e) => setAddress(e.target.value),
              spellCheck: false,
            }),
            h('button', { type: 'submit' }, zh.go))),
        h('div', {
          className: 'dsh-iab-view',
          tabIndex: 0,
          onKeyDown: keyDown,
        },
        frame
          ? h('img', {
            ref: imgRef,
            src: frame,
            alt: '',
            draggable: false,
            onMouseDown: pointer('down'),
            onMouseUp: pointer('up'),
            onMouseMove: (e) => { if (e.buttons) pointer('move')(e); },
            onWheel: wheel,
            onContextMenu: (e) => e.preventDefault(),
          })
          : h('div', { className: 'dsh-iab-hint' }, zh.loading)));
    }

    /** Preferred tab type: a real right-sidebar tab, so it sits beside the session. */
    function tabDefinition() {
      return {
        id: TAB_ID,
        kind: TAB_KIND,
        title: () => zh.title,
        guide: [{ id: 'dsh-iab', kind: TAB_KIND, title: zh.guide, description: zh.guideHint, order: 40 }],
        keepMounted: true,
        multiple: false,
      };
    }

    return {
      name: NS,
      // `slots` and `locale` are the only services this bundle truly cannot
      // live without. `sidebarRightTabs` is declared too — Cordis throws on an
      // *undeclared* service access, so `ctx.sidebarRightTabs?.x` does not guard
      // anything: the property read itself throws. Everything beyond the first
      // two is resolved through dynamic injection below instead, so a core that
      // lacks the right sidebar still activates this entry.
      inject: ['slots', 'locale'],
      apply(ctx) {
        // A UI plugin must never be able to fail the whole boot: DSH treats an
        // unactivated web-boot entry as fatal, so any throw in here would stop
        // the desktop app from starting. Each surface is guarded separately.
        try {
          ensureStyles();
        } catch {
          /* styling is cosmetic */
        }
        try {
          ctx.locale.register(NS, { zh, en });
        } catch {
          /* older cores: labels stay literal */
        }

        // The right-sidebar tab is optional: resolve the registry dynamically and
        // only register when it actually exists.
        //
        // Every service here comes from the injection *scope*. Reading
        // `ctx.sidebarRightTabs` would be an undeclared access — Cordis throws on
        // that, and the throw would take the whole tab registration with it.
        const withSidebar = (registry) => {
          try {
            ctx.effect(() => registry.register(tabDefinition()), 'dsh-iab: tab type');
            ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
              name: 'sidebar.right.pane.tab',
              key: TAB_ID,
              locale: NS,
            }, BrowserPanel)), 'dsh-iab: browser body');
            ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
              name: 'sidebar.right.pane.tab.title',
              key: TAB_ID,
              locale: NS,
            }, () => h('span', null, zh.title))), 'dsh-iab: browser title');
          } catch (error) {
            console.warn('dsh-iab: right-sidebar tab unavailable', error);
          }
        };
        try {
          if (typeof ctx.inject === 'function') {
            ctx.inject(['sidebarRightTabs'], (scope) => {
              const registry = scope?.sidebarRightTabs;
              if (typeof registry?.register === 'function') withSidebar(registry);
            });
          }
        } catch (error) {
          console.warn('dsh-iab: sidebar injection failed', error);
        }

        // Host→client reveal channel. A *tool* starts Chromium out of sight, so
        // without this the user never sees the login wall the tool is blocked on.
        // `sidebarRight` is a separate service from the tab registry, so it is
        // resolved on its own; when it is absent the channel simply stays silent.
        //
        // The controller must come from the injection *scope*, not from `ctx`:
        // reading `ctx.sidebarRight` outside the scope is exactly the undeclared
        // service access Cordis throws on.
        const withReveal = (controller) => {
          ctx.effect(() => {
            const source = new EventSource('/dsh-iab/api/events');
            source.onmessage = (message) => {
              let payload;
              try {
                payload = JSON.parse(message.data);
              } catch {
                return;
              }
              if (payload?.type !== 'reveal') return;
              try {
                // No `replaceTab`: revealing must never close whatever the user
                // already had open in that pane. With `multiple: false` the type
                // has a single page address, so a repeat reveal just focuses it.
                controller.openTab(TAB_KIND);
              } catch (error) {
                // No session surface mounted yet (fresh window, no chat open):
                // nothing to reveal into. The panel is still one click away.
                console.warn('dsh-iab: cannot reveal the panel yet', error);
              }
            };
            source.onerror = () => {
              /* the browser retries on its own */
            };
            return () => source.close();
          }, 'dsh-iab: reveal channel');
        };
        try {
          if (typeof ctx.inject === 'function') {
            ctx.inject(['sidebarRight'], (scope) => {
              const controller = scope?.sidebarRight;
              if (typeof controller?.openTab === 'function') withReveal(controller);
            });
          }
        } catch (error) {
          console.warn('dsh-iab: reveal channel unavailable', error);
        }

        // Settings section: independent of the sidebar, so it registers even when
        // the browser tab cannot. Shows which Chromium and profile the Host picked.
        try {
          ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
            name: 'settings.section',
            id: TAB_ID,
            order: 95,
            locale: NS,
            label: () => zh.title,
          }, function IabSettings() {
            const [data, setData] = React.useState(null);
            React.useEffect(() => {
              void api('/status', undefined, 'GET').then(setData).catch(() => setData(null));
            }, []);
            return h('div', { style: { padding: 16, fontSize: 13, lineHeight: 1.8 } },
              h('h3', { style: { margin: '0 0 8px', fontSize: 14 } }, zh.title),
              h('div', null, `Chromium: ${data?.binary || '(未找到)'}`),
              h('div', null, `Profile: ${data?.profile || ''}`),
              h('div', null, `状态: ${data?.running ? '运行中' : '未启动'}`),
              h('div', null, `Endpoint: ${data?.endpoint || '-'}`));
          })), 'dsh-iab: settings section');
        } catch (error) {
          console.warn('dsh-iab: settings section unavailable', error);
        }
      },
    };
  },
});
