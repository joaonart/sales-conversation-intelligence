"""Fake people and fake (never valid) personal data. Everything here is invented; PII-shaped values deliberately fail real validation."""

from __future__ import annotations

import random
from dataclasses import dataclass

FIRST = [
    "Ana",
    "Bruno",
    "Carla",
    "Diego",
    "Eduarda",
    "Felipe",
    "Gabriela",
    "Henrique",
    "Isabela",
    "João",
    "Karina",
    "Lucas",
    "Mariana",
    "Nicolas",
    "Olívia",
    "Paulo",
    "Quitéria",
    "Rafael",
    "Sabrina",
    "Tiago",
    "Ursula",
    "Vitor",
    "Wesley",
    "Yasmin",
    "Zeca",
    "Camila",
    "Daniel",
    "Fernanda",
    "Gustavo",
    "Helena",
    "Igor",
    "Juliana",
    "Leandro",
    "Marcela",
    "Natália",
    "Otávio",
    "Patrícia",
    "Renato",
    "Simone",
    "Thiago",
    "Vanessa",
    "Alan",
    "Beatriz",
    "Caio",
    "Débora",
    "Eduardo",
    "Flávia",
    "Guilherme",
    "Heloísa",
    "Ícaro",
]
LAST = [
    "Almeida",
    "Barbosa",
    "Cardoso",
    "Dias",
    "Esteves",
    "Ferreira",
    "Gomes",
    "Horta",
    "Lima",
    "Machado",
    "Nogueira",
    "Oliveira",
    "Pereira",
    "Queiroz",
    "Ribeiro",
    "Santos",
    "Teixeira",
    "Vieira",
    "Azevedo",
    "Batista",
    "Campos",
    "Duarte",
    "Farias",
    "Moreira",
    "Nunes",
    "Pinto",
    "Rocha",
    "Siqueira",
]
COMPANIES = [
    "Transportes Horizonte",
    "Clínica Vida Plena",
    "Padaria Pão Nobre",
    "Escritório Silva & Lima",
    "Loja Casa Bela",
    "Oficina Rota 66",
    "Colégio Novo Saber",
    "Distribuidora Norte Sul",
    "Studio Pilates Corpo",
    "Agência Pixel Azul",
    "Construtora Alicerce",
    "Mercado Bom Preço",
    "Laboratório Gênesis",
    "Academia Força Total",
    "Hotel Rio Claro",
    "Contabilidade Prisma",
    "Farmácia Saúde Já",
    "Móveis Ipê",
    "Auto Peças Veloz",
    "Restaurante Sabor da Terra",
]


@dataclass(frozen=True)
class Person:
    pid: str
    first: str
    last: str

    @property
    def full(self) -> str:
        return f"{self.first} {self.last}"


def make_people(rng: random.Random, prefix: str, n: int) -> list[Person]:
    seen: set[str] = set()
    out: list[Person] = []
    while len(out) < n:
        p = Person(f"{prefix}-{len(out) + 1:04d}", rng.choice(FIRST), rng.choice(LAST))
        if p.full in seen:
            continue
        seen.add(p.full)
        out.append(p)
    return out


# ---- fake PII: formats that the masker must catch, values that are never real ----
def fake_cpf(rng: random.Random, dotted: bool = True) -> str:
    d = [rng.randint(0, 9) for _ in range(9)]
    first, second = (sum(v * w for v, w in zip(d, range(10, 1, -1), strict=False)) * 10) % 11 % 10, 0
    check = [(first + 1) % 10, (second + 3) % 10]  # deliberately wrong check digits: not a valid CPF
    digits = "".join(map(str, d + check))
    return f"{digits[:3]}.{digits[3:6]}.{digits[6:9]}-{digits[9:]}" if dotted else digits


def fake_cnpj(rng: random.Random) -> str:
    d = "".join(str(rng.randint(0, 9)) for _ in range(12))
    return f"{d[:2]}.{d[2:5]}.{d[5:8]}/{d[8:12]}-00"


def fake_phone(rng: random.Random) -> str:
    ddd = rng.choice(["11", "21", "31", "41", "51", "61", "71", "81", "85", "62"])
    tail = f"{rng.randint(0, 9999):04d}"
    style = rng.choice(["({d}) 90000-{t}", "{d}90000{t}", "+55 {d} 90000-{t}", "{d} 90000 {t}"])  # 90000-xxxx is not an assigned range
    return style.format(d=ddd, t=tail)


def fake_email(rng: random.Random, person: Person) -> str:
    local = (
        f"{person.first}.{person.last}".lower().replace("í", "i").replace("ã", "a").replace("é", "e").replace("ç", "c").replace("ó", "o")
    )
    return f"{local}{rng.randint(1, 99)}@{rng.choice(['exemplo.com', 'teste.com.br', 'example.org'])}"
