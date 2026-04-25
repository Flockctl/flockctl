---
entity: order
---

# Order state machine

```mermaid
stateDiagram-v2
    [*] --> pending
    pending --> shipped : ship
    pending --> cancelled : cancel
    shipped --> delivered : deliver
```
