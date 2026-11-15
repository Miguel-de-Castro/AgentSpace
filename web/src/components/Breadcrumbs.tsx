import { Fragment } from "react";
import { Link } from "react-router-dom";

export interface Crumb {
  label: string;
  to?: string;
}

// .claude/plans/17-ux-navigation-polish.md P1 — one reusable trail
// (Projects / <Project> / <Mission>) replacing the ad-hoc "← Back to X" links,
// so there's always a clear "where am I" and a way up at every level. The last
// crumb is the current page (no link). Per-page, not in AppHeader: the trail is
// contextual, the header nav is global.
export function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground flex items-center gap-1.5 flex-wrap">
      {items.map((item, i) => {
        const isLast = i === items.length - 1;
        return (
          <Fragment key={i}>
            {item.to && !isLast ? (
              <Link to={item.to} className="hover:text-foreground underline underline-offset-2 transition-colors">
                {item.label}
              </Link>
            ) : (
              <span className={isLast ? "text-foreground truncate max-w-[22rem]" : undefined}>{item.label}</span>
            )}
            {!isLast && <span aria-hidden className="opacity-60">/</span>}
          </Fragment>
        );
      })}
    </nav>
  );
}
