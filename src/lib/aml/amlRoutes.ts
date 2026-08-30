/**
 * Where the staff AML surfaces actually live.
 *
 * ── The 404 this exists to prevent ────────────────────────────────────
 * Stage 5's only offered action for a provider fault navigated to
 * `/aml/configuration`, which is not a route. `/aml` and `/aml/passport` ARE
 * routes — they are the CLIENT-facing surfaces — so the path looked plausible
 * and failed at run time rather than at build time. Every staff AML page is
 * mounted under `/admin/aml/*`, and the sidebar had always linked there; this
 * one navigation did not, so the single step an operator was given for
 * "Screening cannot run yet" led nowhere.
 *
 * A named constant rather than a literal at each call site, so the next
 * surface that needs it cannot spell it differently, and so a test can assert
 * no `/aml/configuration` literal survives anywhere.
 */
export const ADMIN_AML_CONFIGURATION_PATH = "/admin/aml/configuration";

/**
 * Where the sanctions lists are loaded and their health is shown.
 *
 * Named here for the same reason the configuration path is: the one Stage 5
 * navigation that was hand-written led to a route that did not exist, and a
 * dead link is how an operator concludes the feature is broken.
 *
 * ── Why it moved ──────────────────────────────────────────────────────
 * It used to be `/admin/aml/verification`, because `SanctionsListHealth` was
 * mounted on that page and on no other. That made the health of the register
 * discoverable ONLY from a case Stage 5 had already blocked — and the health
 * of the register is an organisation-level fact. `sanctions_entries` was
 * empty from the day this platform was built, for three independent reasons,
 * each of which reported as normal operation; a screening register nobody can
 * check without a blocked case is how that happens again.
 *
 * The panel now sits on Configuration under Providers, beside the credentials
 * it is loaded with. The anchor is part of the destination rather than
 * decoration: Configuration is a tabbed page, and landing an operator at the
 * top of it with no idea which tab holds what they were sent for is the same
 * dead-end in a different shape.
 */
export const ADMIN_AML_LIST_HEALTH_PATH =
  `${ADMIN_AML_CONFIGURATION_PATH}?tab=providers#sanctions-list-health`;
