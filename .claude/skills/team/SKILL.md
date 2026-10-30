---
name: team
description: Run the five-agent dev team (superpower-planner, context7-modernizer, claude-reviewer, code-cleaner, gstack-leader) on a feature or fix, from plan to ship decision. Use when the user types /team or asks to "use the team" on a task.
---

# Dev Team Workflow

Subagents can't call each other, so YOU (the main agent) run the team in this order and pass each agent's output to the next. The task is: $ARGUMENTS

## Step 1 — Plan
Use the **superpower-planner** agent: brainstorm, write small tasks, test-first for each.
If its output has **Questions for the user**, ask them and wait before continuing.

## Step 2 — Leadership plan review
Use the **gstack-leader** agent at stage PLAN with the plan.
- NO-GO or GO WITH CHANGES → send the required changes back to superpower-planner, then re-review once.

## Step 3 — Check the tech
Use the **context7-modernizer** agent on the plan's libraries/frameworks. Update the plan with the correct current APIs it reports.

## Step 4 — Build (main agent)
Implement the plan task by task yourself:
1. Write the task's test → run it → confirm it fails.
2. Write the minimal code → run it → confirm it passes.
3. Tick the task off in the plan file.

## Step 5 — Review
Use **claude-reviewer** and **context7-modernizer** (post-code check) — run them in parallel.
Fix every 🔴 item and every deprecated/hallucinated API, then re-run claude-reviewer until no 🔴 remains (max 3 rounds; then stop and ask the user).

## Step 6 — Clean
Use the **code-cleaner** agent. Tests must be green before and after.

## Step 7 — Ship decision
Use **gstack-leader** at stage SHIP. Report its decision to the user with the suggested commit message.
Do not commit, push or open a PR unless the user says so.

## Final message to the user
Keep it short: what was built, tests status, leader's decision, and any open items.
