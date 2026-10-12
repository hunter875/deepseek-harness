---
name: review
description: Review a scoped EduMatch diff against confirmed contracts and report actionable findings with evidence.
---

Read the frozen review contract, diff, relevant callers and tests from the indexed revision. For cross-service changes inspect both boundaries. Compare behavior with confirmed API/event/data expectations; implementation itself is not business authority.

Use registered read and fixture verification capabilities. Report a concrete trigger, impact and file/line for each actionable finding. Explain the inspected scope and missing evidence. Only the runner supplies REVIEWED; this status does not guarantee the whole system has no defects.
