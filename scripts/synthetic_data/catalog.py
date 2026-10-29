"""Fictional catalogues (invented brands) for the two synthetic businesses."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Product:
    name: str
    kind: str
    price: int  # BRL, integer for readable chat
    specs: str
    warranty: int  # months
    competitor_price: int  # what "the other store" claims
    fem: bool = False  # grammatical gender for "o/a"


RETAIL = [
    Product("Fone Bluetooth AirTune X2", "audio", 249, "bateria de 30h, Bluetooth 5.3 e cancelamento de ruído", 12, 219),
    Product("Notebook Vega 14 i5 16GB", "computer", 3899, "Intel i5, 16GB de RAM, SSD de 512GB e tela de 14 polegadas", 12, 3699),
    Product("Smart TV Lumina 50 4K", "tv", 2499, "tela 4K de 50 polegadas, 3 HDMI e Wi-Fi integrado", 12, 2349, True),
    Product("Soundbar Pulse 2.1", "audio", 799, "2.1 canais, 120W e subwoofer sem fio", 12, 729, True),
    Product("Smartwatch Fit Pro", "wearable", 599, "GPS, monitor cardíaco e 7 dias de bateria", 12, 549),
    Product("Cafeteira Aroma Plus", "home", 389, "19 bares de pressão, vaporizador e reservatório de 1,2L", 12, 349, True),
    Product("Aspirador Robô CleanBot", "home", 1699, "mapeamento a laser, 3000Pa e retorno automático à base", 12, 1590),
    Product("Câmera Wi-Fi Eye 2K", "security", 229, "resolução 2K, visão noturna e áudio bidirecional", 6, 199, True),
    Product("Monitor Gamer 27 165Hz", "computer", 1399, "27 polegadas, 165Hz, painel IPS e 1ms", 12, 1299),
    Product("Cadeira Ergonômica Flex", "furniture", 1199, "ajuste lombar, apoio de braço 4D e carga de até 150kg", 24, 1099, True),
]

DELIVERY_DAYS = [2, 3, 4, 5, 7]
STORE = "TecnoCasa"
COMPETITORS = ["Mercado Livre", "a Magalu", "a Amazon", "um site que achei", "a loja do shopping"]

SAAS_PLANS = [
    ("Start", 199, "até 5 usuários, relatórios básicos e suporte por e-mail"),
    ("Growth", 799, "até 25 usuários, integração com ERP, relatórios avançados e suporte prioritário"),
    ("Scale", 2490, "usuários ilimitados, SSO, SLA de 99,9% e gerente de conta dedicado"),
]
SAAS_BRAND = "Fluxo360"
SAAS_COMPETITORS = ["a Omie", "o sistema que a gente usa hoje", "uma planilha mesmo", "o concorrente que me ligou"]
