# ADR-7378: decision recorded under "OAuth code-display login"

- Purpose: let an operator dismiss the obsolete error of a failed add-account attempt (#7378).
- Constraint: flow outcome and persisted active-account health are independent; concurrent code
  logins and provider ownership already have dedicated flow-key APIs.
- Alternatives: hide every flow error whenever a credential exists, expire outcomes by time, or
  reuse the explicit cancellation endpoint. Hiding errors would conceal a real failed add-account
  attempt; a timer could erase an outcome before a polling caller reads it.
- Decision: extend the existing cancellation owner to drop exactly one settled failed flow with
  no live controller, only when the public endpoint explicitly opts in. Internal callers retain
  the boolean meaning of live cancellation. Reuse paste cleanup and waiter-safe flow removal, without credential I/O.
- Consequences: failures remain observable until explicitly dismissed; successful outcomes and
  pending-cancellation results keep their contract. Repeated dismissal is a no-op. This provides
  API recovery without an implicit login, logout, credential refresh or service restart.
