window.__ModuleLoader__.load({
  id: 'k10-dsh-focus',
  factory: () => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const inject = ['sessions'];

    function apply(ctx) {
      const url = new URL(window.location.href);
      const sessionId = url.searchParams.get('k10-session');
      let cancelled = false;
      let lastSequence = 0;
      const cleanUrl = () => {
        const clean = new URL(window.location.href);
        clean.searchParams.delete('k10-session');
        window.history.replaceState(null, '', `${clean.pathname}${clean.search}${clean.hash}`);
      };
      const openLaunchParameter = async () => {
        if (!sessionId) return;
        const deadline = Date.now() + 10000;
        while (!cancelled && Date.now() < deadline) {
          const sessions = ctx.get('sessions');
          if (sessions) {
            try {
              sessions.open(sessionId);
              cleanUrl();
              return;
            } catch {}
          }
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        cleanUrl();
      };

      const poll = async () => {
        while (!cancelled) {
          try {
            const response = await fetch('/api/k10-focus', { cache: 'no-store' });
            const command = await response.json();
            if (command.seq > lastSequence) {
              lastSequence = command.seq;
              if (command.sessionId && Date.now() - command.issuedAt < 15000) {
                ctx.get('sessions')?.open(command.sessionId);
              }
            }
          } catch {}
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      };

      void openLaunchParameter();
      void poll();
      ctx.effect(() => () => { cancelled = true; }, 'k10-dsh-focus: deep link');
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
