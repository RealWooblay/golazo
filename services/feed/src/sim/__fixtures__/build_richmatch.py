#!/usr/bin/env python3
"""
Generator for `rich-match.json` — a realistic, COMPREHENSIVE ~90'+ match used by
the full-game market simulation. Unlike the thin one-goal Paraguay–Türkiye replay,
this fixture deliberately exercises EVERY market path the engine can produce:

  • Goals of every type, for BOTH teams:
      - open play (home + away)
      - from a corner (away)            -> goal_from_corner YES (parseGoalSource)
      - from a free kick (home)         -> goal_from_free_kick YES
      - a penalty (home), converted     -> penalty_scored / penalty_awarded YES
  • Set-pieces that DON'T score (corners + FKs that fizzle) -> NO via deadline sweep
  • Shots + misses (saved/blocked/wide) for both teams -> shot_in_window YES + NO
  • Attacks / dangerous attacks / corners / free kicks (attacking + defensive)
  • A red card behind a VAR review (VAR check -> red_card_given YES)
  • A VAR penalty review that's DENIED (penalty_awarded NO) and one AWARDED (YES)
  • Momentum SWINGS: a sustained home siege, a swing to away, and genuinely quiet
    spells (throw-ins / ball out / nothing) so the bar must decay back to neutral.
  • ESPN-style feed lag + a couple of out-of-order stamps (goal text lands a beat
    after its build-up; a shot stamped slightly out of order) so deterministic
    resolution is tested under the real failure mode.
  • Half-time and late-game stoppage (90'+ events).

Run:  python3 build_richmatch.py   (writes rich-match.json next to this file)

The shapes mirror ESPN's free summary API exactly (see espn.ts), so the same
normalizers the live feed uses classify it identically.
"""
import json
import os

HOME_ID = "100"   # Albion (home)
AWAY_ID = "200"   # Rovers (away)
HOME = "Albion"
AWAY = "Rovers"

commentary = []
key_events = []
_seq = 0
_ke = 0


def cseq():
    global _seq
    _seq += 1
    return _seq


def keid():
    global _ke
    _ke += 1
    return 90000 + _ke


def cm(clock, text):
    """A commentary line (free-text play-by-play)."""
    commentary.append({
        "sequence": cseq(),
        "time": {"displayValue": clock},
        "text": text,
    })


def goal(clock, team_id, team_name, text):
    """A structured scoring keyEvent (authoritative). `text` drives parseGoalSource."""
    key_events.append({
        "id": keid(),
        "type": {"id": "70", "text": "Goal", "type": "goal"},
        "text": text,
        "clock": {"displayValue": clock},
        "scoringPlay": True,
        "team": {"id": team_id, "displayName": team_name},
    })


def ke(clock, type_text, team_id=None, text=None, type_id="0"):
    """A non-scoring structured keyEvent (penalty, card, sub, delay)."""
    e = {
        "id": keid(),
        "type": {"id": type_id, "text": type_text},
        "clock": {"displayValue": clock},
        "scoringPlay": False,
    }
    if text:
        e["text"] = text
    if team_id:
        e["team"] = {"id": team_id}
    key_events.append(e)


# ───────────────────────────────────────────────────────────────────────────
# FIRST HALF
# ───────────────────────────────────────────────────────────────────────────
cm("", "Lineups are announced and the players are warming up.")
cm("", "First Half begins.")

# 2' — HOME open-play goal (open play; parseGoalSource -> not a setpiece -> the
# momentum / open-play markets that are live settle YES via late-goal rescue).
cm("1'", f"{HOME} building from the back, pushing forward into the final third.")
cm("2'", f"Big chance for {HOME}! A through ball releases the striker.")
goal("2'", HOME_ID, HOME,
     f"Goal! {HOME} 1, {AWAY} 0. Open-play move finished low into the bottom corner. Assisted by the winger.")

# 5'-9' — AWAY pushes back: attacks, a defensive FK (own half -> NOT bettable),
# a corner that fizzles (no goal -> NO).
cm("5'", f"{AWAY} on the attack now, building pressure down the right.")
cm("6'", f"Midfielder ({AWAY}) wins a free kick in the defensive half.")  # defensive -> skipped
cm("7'", f"{AWAY} surging forward, quick transition through midfield.")
cm("8'", f"Corner, {AWAY}. Conceded by a defender.")  # opens goal_from_corner (away)
cm("8'", f"Corner taken by {AWAY}, headed clear at the near post.")        # resolver: cleared
cm("9'", "The ball is played back and {0} recycle possession.".format(AWAY))

# 11' — quiet spell (throw-ins / ball out) so momentum decays toward neutral.
cm("10'", "Throw-in deep in midfield.")
cm("11'", "The ball runs out of play for a goal kick. A lull in the game.")
cm("12'", "Both sides catching their breath, possession traded in midfield.")

# 14' — AWAY corner that SCORES -> goal_from_corner YES (parseGoalSource 'from a corner').
cm("13'", f"{AWAY} working it wide, building an attack down the flank.")
cm("14'", f"Corner, {AWAY}. Conceded by the full-back.")  # opens goal_from_corner (away)
goal("14'+1'", AWAY_ID, AWAY,
     f"Goal! {HOME} 1, {AWAY} 1. Header from a corner, bundled in at the back post.")

# 17'-19' — HOME pressure, an attacking free kick that does NOT score -> NO.
cm("17'", f"{HOME} pressing forward again, in the final third.")
cm("18'", f"Winger ({HOME}) wins a free kick in the attacking half.")  # opens goal_from_free_kick (home)
cm("19'", f"{HOME} free kick is played short and worked into the wall, cleared away.")  # resolver

# 22'-25' — AWAY shots: one on target (shot), one saved (miss) -> shot_in_window YES.
cm("21'", f"{AWAY} on top now, building pressure with a series of attacks.")
cm("22'", f"{AWAY} dangerous attack, a cut-back across the six-yard box.")
cm("23'", "Attempt saved. A fierce drive is turned around the post.")  # miss (away by context)
cm("24'", f"{AWAY} keep coming, another attack down the left.")
cm("25'", f"Shot on target by {AWAY}, forces a save low to the right.")  # shot

# 28' — HOME wins a PENALTY (keyEvent) then SCORES it -> penalty_awarded + penalty_scored YES.
cm("27'", f"{HOME} breaking into the box, a real chance here.")
ke("28'", "Penalty", team_id=HOME_ID, text=f"Penalty awarded to {HOME} after a foul in the box.", type_id="155")
goal("28'+1'", HOME_ID, HOME,
     f"Goal! {HOME} 2, {AWAY} 1. Penalty scored, sent the keeper the wrong way.")

# 31'-34' — quiet, then a defensive FK (away, own half) and a home attacking FK.
cm("31'", "A scrappy spell, the ball pinging around midfield, out for a throw.")
cm("32'", f"Defender ({AWAY}) wins a free kick in the defensive half.")  # defensive -> skipped
cm("34'", f"Striker ({HOME}) wins a free kick in the attacking half.")   # opens goal_from_free_kick (home)
cm("35'", f"{HOME} free kick whipped in, headed away by the defence.")   # resolver: cleared -> NO

# 38' — AWAY momentum + a missed big chance.
cm("37'", f"{AWAY} building again, sustained pressure, a real spell on top.")
cm("38'", f"{AWAY} counter-attack, three on two, golden chance!")
cm("39'", "Attempt missed. The shot flashes wide of the far post.")  # miss

# 41' — VAR penalty review for HOME, DENIED -> penalty_awarded NO.
cm("41'", f"The referee is checking the monitor — VAR review for a possible penalty to {HOME}.")
cm("42'", "VAR Decision: No penalty. Play continues, the appeals waved away.")  # var_penalty_denied -> NO

# 45' — stoppage, then half time.
cm("45'", f"{HOME} win a free kick in the defensive half as the half winds down.")
cm("45'+2'", "Throw-in, the ball worked back to the keeper.")
ke("45'", "Halftime", text="First Half ends, Albion 2, Rovers 1.", type_id="26")
cm("45'+3'", "First Half ends, Albion 2, Rovers 1.")

# ───────────────────────────────────────────────────────────────────────────
# SECOND HALF
# ───────────────────────────────────────────────────────────────────────────
ke("45'", "Start 2nd Half", text="Second Half begins.", type_id="22")
cm("46'", "Second Half begins. Albion 2, Rovers 1.")

# 48'-52' — HOME siege: SUSTAINED home pressure (many weighted events) to drive
# the bar hard toward home and open momentum 'score_in_window' markets.
cm("47'", f"{HOME} straight on the front foot, building pressure.")
cm("48'", f"{HOME} dangerous attack, cutting it back across the box.")
cm("49'", f"Corner, {HOME}. Conceded by the centre-back.")   # opens goal_from_corner (home)
cm("49'", f"{HOME} corner headed over the bar.")             # resolver
cm("50'", f"{HOME} relentless, another dangerous attack into the area.")
cm("51'", f"Shot on target by {HOME}, tipped onto the bar!")  # shot
cm("52'", f"{HOME} still all over them, sustained siege pressure.")

# 54' — HOME free-kick GOAL -> goal_from_free_kick YES (parseGoalSource).
cm("53'", f"Playmaker ({HOME}) wins a free kick in the attacking half.")  # opens goal_from_free_kick (home)
goal("54'", HOME_ID, HOME,
     f"Goal! {HOME} 3, {AWAY} 1. Curling shot scored directly from the free-kick into the top corner.")

# 57'-60' — swing to AWAY: away now presses (bar must flip to away).
cm("56'", f"{AWAY} respond, pushing forward in numbers now.")
cm("57'", f"{AWAY} on the attack, building real pressure of their own.")
cm("58'", f"{AWAY} dangerous attack, a driving run into the box.")
cm("59'", f"Shot on target by {AWAY}, a stinging save needed!")  # shot
cm("60'", f"Corner, {AWAY}. Conceded by the right-back.")  # opens goal_from_corner (away)
cm("61'", f"{AWAY} corner cleared to the edge, recycled and lost.")  # resolver -> NO

# 63' — AWAY open-play GOAL (pulls one back) -> open-play; momentum YES for away.
cm("62'", f"{AWAY} breaking forward, a clear chance through the middle!")
goal("63'", AWAY_ID, AWAY,
     f"Goal! {HOME} 3, {AWAY} 2. Slotted home from open play after a flowing move. Assisted by the substitute.")

# 66' — genuinely QUIET spell (decay back to neutral): throw-ins, ball out, nothing.
cm("65'", "A scrappy, quiet spell — throw-in, ball out for a goal kick.")
cm("66'", "Possession traded in midfield, the tempo drops right off.")
cm("67'", "Another stoppage, the ball out of play. The game has gone flat.")

# 69'-72' — VAR RED CARD review for AWAY -> red_card_given YES (the red lands).
cm("69'", f"The referee goes to the pitchside monitor — VAR review for a possible red card, {AWAY}.")
ke("71'", "Red Card", team_id=AWAY_ID, text=f"{AWAY} defender is shown a straight red card after the VAR review.", type_id="98")

# 74'-77' — HOME pile on against ten men: siege, corners, shots.
cm("73'", f"{HOME} pressing the advantage against ten men, on top.")
cm("74'", f"{HOME} dangerous attack, swinging it into the box.")
cm("75'", f"Corner, {HOME}. Conceded by the left-back.")   # opens goal_from_corner (home)
cm("75'", f"{HOME} corner met by a header, just wide.")    # resolver -> NO
cm("76'", f"Shot on target by {HOME}, superbly saved!")    # shot
cm("77'", f"{HOME} still pushing, relentless pressure now.")

# 79' — VAR PENALTY review for HOME, AWARDED -> penalty_awarded YES, then MISSED.
cm("79'", f"VAR review — checking a possible penalty for {HOME}, handball in the area.")
ke("80'", "Penalty", team_id=HOME_ID, text=f"Penalty awarded to {HOME} after the VAR review for handball.", type_id="155")
# Penalty MISSED -> penalty_scored NO (the penalty_awarded market already YES'd on the award).
ke("81'", "Penalty - Missed", team_id=HOME_ID, text="Penalty missed! The spot-kick is blazed over the bar.", type_id="156")

# 83'-86' — AWAY late rally (ten men but throwing bodies forward): attacks, a FK.
cm("83'", f"{AWAY} throwing everyone forward, a late rally.")
cm("84'", f"Substitute ({AWAY}) wins a free kick in the attacking half.")  # opens goal_from_free_kick (away)
cm("85'", f"{AWAY} free kick dropped into the box, headed clear.")          # resolver -> NO
cm("86'", f"{AWAY} dangerous attack, one last surge into the area.")

# 88' — quiet again before stoppage (decay).
cm("88'", "The ball is shielded out for a throw, time being run down.")

# 90'+ — STOPPAGE TIME: a frantic finish, a final corner, late shot.
cm("90'+1'", f"{HOME} on the attack as we move into stoppage time.")
cm("90'+2'", f"Corner, {HOME}. Conceded deep in stoppage time.")  # opens goal_from_corner (home)
cm("90'+3'", f"{HOME} corner swung in, scrambled away on the line.")  # resolver -> NO
cm("90'+4'", f"Shot on target by {HOME}! Saved at the death.")        # shot
cm("90'+6'", "The referee brings the game to an end.")
ke("90'+6'", "End Regular Time", text="Match ends, Albion 3, Rovers 2.", type_id="27")

# ───────────────────────────────────────────────────────────────────────────
# Assemble the ESPN-shaped fixture.
# ───────────────────────────────────────────────────────────────────────────
scoreboard = {
    "events": [
        {
            "id": "999001",
            "status": {
                "displayClock": "90'+6'",
                "period": 2,
                "type": {"state": "post", "completed": True, "detail": "FT"},
            },
            "competitions": [
                {
                    "competitors": [
                        {
                            "homeAway": "home",
                            "score": "3",
                            "team": {"id": HOME_ID, "displayName": HOME, "abbreviation": "ALB", "color": "1f6feb"},
                        },
                        {
                            "homeAway": "away",
                            "score": "2",
                            "team": {"id": AWAY_ID, "displayName": AWAY, "abbreviation": "ROV", "color": "d4351c"},
                        },
                    ]
                }
            ],
        }
    ]
}

summary = {"commentary": commentary, "keyEvents": key_events}

out = {"scoreboard": scoreboard, "summary": summary}
path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "rich-match.json")
with open(path, "w") as f:
    json.dump(out, f, indent=0, ensure_ascii=False)
print(f"wrote {path}: {len(commentary)} commentary, {len(key_events)} keyEvents")
