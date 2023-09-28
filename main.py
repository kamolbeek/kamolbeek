from os import system
import random as rd

class counter_strike:
    _health_spez = 100
    _health_terror = 100
    _sch_terror = 0
    _sch_spez = 0
    def _new_game(self):
        counter_strike._health_spez = 100
        counter_strike._health_terror = 100
    def all_game(self):
        return counter_strike._sch_spez + counter_strike._health_terror
    def tablo(self):
        print(f" Hisob Terrorist {counter_strike._health_terror}:{counter_strike._health_spez}")

class terrorist(counter_strike):
    count_terror = 0
    def __init__(self):
        terrorist.count_terror = 1
    def otish(self,pozition):
        if pozition == "Head":
            counter_strike._health_spez -= -60
        elif pozition == "Foot":
            counter_strike._health_spez -= -20
        elif pozition == "Hand":
            counter_strike._health_spez -= -10
        else:
            counter_strike._health_spez -= -40
        if counter_strike._health_spez <= 0:
            print("'Terrorist Win: '  ",end=" ")
            counter_strike._sch_terror += 1
            counter_strike._new_game()
            counter_strike.tablo()

class countre(counter_strike):
    def __init__(self):
        if terrorist.count_terror > 0:
            print("Start Game")
        else:
            print("Wait terrorist")
    def otish(self,pozition):
        if pozition == "Head":
            counter_strike._healt_terror -= 60
        elif pozition == "Foot":
            counter_strike._healt_terror -= 20
        elif pozition == "Hand":
            counter_strike._health_terror -= 10
        else:
            counter_strike._healt_terror -= 40
        if counter_strike._healt_terror <= 0:
            print("'Countre-Terrorist Win:'  ",end="")
            counter_strike._sch_spez += 1
            counter_strike._new_game()
            counter_strike.tablo()

cs = counter_strike()
ct = countre()
tr = terrorist()
ct = countre()
ls = ["Hand","Head","Foot","Tana"]
while cs.all_game() < 15:
    son = rd.randint(0,100)
    if son % 2:
        tr.otish(rd.choise(ls))
    else:
        ct.otish(rd.choise(ls))
print("*"*40)
print("_"*40)
counter_strike.tablo()