# Architectural Tests

Not implementation documentation. This is the set of questions every future feature or architectural decision must answer before it's accepted, so the architecture doesn't quietly drift back toward being "a UI for Claude Code" as convenience pressure accumulates over time.

If a decision fails one of these, that's not automatically disqualifying — but it needs an explicit, written reason, not a shrug.

---

1. **Can this component be explained without mentioning Claude Code by name?**
   If the answer requires saying "Claude Code," the component probably belongs in the Provider Adapter, not in Mission Engine or Execution Engine.

2. **If Claude Code became dramatically better over the next five years, would this decision make AgentSpace more valuable, or less?**
   "Less valuable" is the signature of building around Claude Code's current shape instead of around the developer's workflow. See the product thesis in `00-VISION.md`.

3. **Does this abstraction exist because of the domain, or because of today's implementation?**
   A layer justified by "we might need it for a future provider" without a concrete domain reason (see test 8) is speculative engineering, not architecture.

4. **Can git remain the single source of truth for what changed?**
   Any capability that depends on a provider's own diff/checkpoint mechanism instead of git-computed before/after state is a fragility risk — see T-002 in `16-ASSUMPTIONS.md`.

5. **Is this abstraction earning its cost today, or is it "just in case" for a future we haven't validated?**
   Prefer boring, direct code over a seam nothing currently uses. An unused abstraction is a maintenance cost with no offsetting benefit.

6. **Does this increase developer trust, or does it just increase the amount of information on screen?**
   More visibility is not automatically more trust (see P-006 in `16-ASSUMPTIONS.md`). A feature that adds detail without adding confidence has failed its actual job.

7. **Is policy leaking into mechanism, or mechanism leaking into policy?**
   Mission Engine decides *what* is allowed (e.g., which branches are protected). Provider Adapter only *enforces* that decision at the provider level (e.g., translating a policy into a blocking hook response). If a provider-specific detail starts influencing what counts as risky, the boundary has been violated.

8. **If we had to support a second provider tomorrow, would this decision force us to touch Mission Engine or Execution Engine?**
   If yes, this capability was miscategorized — it belongs in the Provider Adapter, or the domain concept it's attached to needs to be redefined to not assume Claude Code's specific shape (see the Team Member / Claude Code subagent distinction in `02-DOMAIN.md`).

9. **Does this durability claim depend on something we don't control?**
   An undocumented file format, an unversioned API response shape, or "this has always worked this way" is not a foundation for a system-of-record claim. See T-006 in `16-ASSUMPTIONS.md`.

10. **Are we modeling a real graph or one-to-many relationship as if it were linear or one-to-one, for convenience?**
    Watch for pipeline diagrams that quietly flatten a fan-out or an aggregation into a single terminal step (the Trust Ledger was originally miscast this way — see `02-DOMAIN.md`). A relationship that's actually many-to-many doesn't become simpler by drawing it as an arrow.
