# Turning the release check off now hides its entry too

`PENGUIN_UPDATE_CHECK=off` used to stop the lookup and nothing else: the account menu kept its row, and opening it led to a modal with no version to compare and no release URL to follow (both are null in a `disabled: true` response) — in effect telling the reader to go look on GitHub.

The row now goes away with the lookup. That is what makes the switch a genuinely quiet deployment: the row is where the app starts its only self-initiated outbound request, so with no entry there is no path that dials out.

Defaults are unchanged: without the variable the check runs and the row is there.
