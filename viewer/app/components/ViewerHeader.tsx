type ViewerHeaderProps = {
  topBarTitle: string;
  subtitle: string;
};

export default function ViewerHeader({
  topBarTitle,
  subtitle,
}: ViewerHeaderProps) {

  return (
    <header className="fixed inset-x-0 top-0 z-10 w-full border-b border-white/10 bg-[#0a0c10]/95 py-3 px-[10px] sm:px-6 lg:px-8 backdrop-blur">
      <div className="flex w-full items-center justify-between gap-3">
        <div className="flex flex-1 min-w-0 items-center gap-4">
          <div className="flex h-[90px] w-[90px] items-center justify-center overflow-hidden rounded-full bg-white/5">
            <img
              src="/logo-dark.png"
              alt="Apartment Cam Logo"
              width={90}
              height={90}
              className="h-full w-full object-contain"
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="viewer-header-title text-[18px] sm:text-[20px] uppercase tracking-[0.25em]">
              {topBarTitle}
            </span>
            <span className="text-[11px] uppercase tracking-[0.12em] text-slate-400">
              {subtitle}
            </span>
          </div>
        </div>

        <div className="flex flex-shrink-0 items-center justify-end gap-5 pr-3">
          <div className="viewer-header-actions items-center space-x-3 mr-5">
            <button
              type="button"
              disabled
              className="btn rounded-full border border-transparent bg-emerald-600 px-4 py-1.5 text-[10px] uppercase tracking-[0.25em] text-white opacity-60 shadow-[0_0_0_1px_rgba(255,255,255,0.2)] cursor-not-allowed"
              aria-label="Publish (disabled)"
              title="Publish (disabled)"
            >
              publish
            </button>
            <div className="hidden md:block">
              <button
                type="button"
                disabled
                className="btn rounded-full border border-white/30 bg-transparent px-4 py-1.5 text-[10px] uppercase tracking-[0.25em] text-white opacity-60 cursor-not-allowed"
                aria-label="Add Cam (disabled)"
                title="Add Cam (disabled)"
              >
                add cam
              </button>
            </div>
          </div>
          <button
            type="button"
            disabled
            className="flex h-16 w-16 items-center justify-center rounded-full border border-white/20 bg-white/5 text-[32px] text-slate-400 opacity-80 cursor-not-allowed"
            aria-label="Viewer avatar (disabled)"
            title="Viewer avatar (disabled)"
          >
            <span className="text-[32px]" aria-hidden="true">
              👤
            </span>
          </button>
        </div>
      </div>
    </header>
  );
}
