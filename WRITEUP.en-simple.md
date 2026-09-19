# SignalFlow — Writeup (English, simple language)

**A traffic light that watches where the cars are waiting.**

> This writeup comes in four versions:
> **English simple** (this file) ·
> [English detailed](WRITEUP.en.md) ·
> [Deutsch ausführlich](WRITEUP.md) ·
> [Deutsch einfach](WRITEUP.einfach.md)

---

## What is the problem?

Many traffic lights follow a fixed plan. The plan says: first 30 seconds
green for the road from the north. Then 30 seconds for the road from the
east. The same, all day long.

The problem: sometimes no cars are waiting at a red light. The green light
shines for nobody. And the cars on the other road still have to wait. That
is annoying. It wastes time and fuel.

## What does SignalFlow do?

SignalFlow is a traffic-light control that **watches**. Every second it
counts how many cars wait in each direction. Then it gives green to the
direction with the biggest queue. When a queue is empty, the light switches
on sooner. This is called **adaptive**.

## How do we know it is better?

We let two traffic lights compete: one with a fixed plan, one with
SignalFlow. **Both get exactly the same cars.** Then we compare.

The result at one Munich junction (30 minutes of rush hour):

* Cars wait **about a quarter less** (53.9 down to 40.7 seconds per car —
  24.5 % less).
* **68 % less green time wasted** on empty streets.
* Less exhaust, because fewer cars sit idling (about 24 % less).

We test the same for whole districts — with real streets from
OpenStreetMap: Munich, Berlin, Hamburg, Cologne and Heidelberg. There,
waiting time drops by **60 to 80 %**.

## Four kinds of traffic lights

1. **The fixed light:** it has a plan and never looks. Simple, but it wastes
   time.
2. **The adaptive light (SignalFlow):** it watches live and gives the queue
   the right of way. Wins almost always.
3. **The green wave:** all lights on one big road switch in the same rhythm.
   Great on a long, free road. Worse in a dense city centre.
4. **The learned fixed light (Tuned\*):** it also has a fixed plan — but the
   plan was computed from real counting-loop data. In some city-centre
   networks it even beats the adaptive light!

**We are honest:** the adaptive light does not always win. We show that
anyway. That is how the results stay trustworthy.

## Who built this?

A small team at the **MunichTech EXPO 2026** hackathon, with help from AI
(Claude Code) — but every number comes from real simulation runs, and an
automatic check rejects any answer with made-up numbers.

## Read more

* [The whole project on GitHub](https://github.com/derKosi/SignalFlow)
* [The long version](WRITEUP.en.md) — with all the details
* [Try it yourself](https://github.com/derKosi/SignalFlow#readme) — how to
  start the demo on your own computer

*Code licence: PolyForm Noncommercial · Map data: © OpenStreetMap*
