"""Decimal comparison only. Strings preserve source precision; formatting is separate."""
import re
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP, localcontext

VERSION = 'decimal-v0.7-exact-or-half-up'
NUMBER = r'[+-]?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?'

def parse(value):
    if isinstance(value, bool) or not isinstance(value, (str, int, float, Decimal)):
        return None
    text = str(value).strip()
    if len(text) > 160 or not re.fullmatch(NUMBER, text):
        return None
    text = re.sub(r'^([+-]?)\.', lambda m: m[1]+'0.', text)
    m = re.fullmatch(r'([+-]?)([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?', text)
    if len(m[2]) > 100 or len(m[3] or '') > 30 or abs(int(m[4] or 0)) > 30:
        return None
    try:
        return Decimal(text)
    except InvalidOperation:
        return None

def quantitative(claim, evidence, policy=None):
    policy = policy if policy is not None else {'mode': 'exact'}
    if not isinstance(claim, dict) or not isinstance(evidence, dict) or not isinstance(policy, dict):
        return 'UNKNOWN'
    mode = policy.get('mode')
    if mode not in {'exact', 'round'}:
        return 'UNKNOWN'
    places = policy.get('places')
    if mode == 'round' and (type(places) is not int or not 0 <= places <= 8 or policy.get('rounding', 'HALF_UP') != 'HALF_UP'):
        return 'UNKNOWN'
    for key in ['entity', 'metric', 'period', 'scope']:
        if not claim.get(key) or not evidence.get(key):
            return 'UNKNOWN'
    if any(claim[k] != evidence[k] for k in ['entity', 'metric', 'period', 'scope']):
        return 'FAIL'
    units = {'元': ('money', 0), '万元': ('money', 4), '亿元': ('money', 8), '%': ('ratio', -2), '比例': ('ratio', 0)}
    cu, eu = units.get(claim.get('unit')), units.get(evidence.get('unit'))
    if not cu or not eu:
        return 'UNKNOWN'
    if cu[0] != eu[0]:
        return 'FAIL'
    target_unit = units.get(policy.get('unit', claim['unit']))
    if not target_unit:
        return 'UNKNOWN'
    if target_unit[0] != cu[0]:
        return 'FAIL'
    if cu[0] == 'money':
        if not claim.get('currency') or not evidence.get('currency'):
            return 'UNKNOWN'
        if claim['currency'] != evidence['currency']:
            return 'FAIL'
    a, b = parse(claim.get('value')), parse(evidence.get('value'))
    if a is None or b is None:
        return 'UNKNOWN'
    with localcontext() as ctx:
        ctx.prec = 240
        a = a.scaleb(cu[1]-target_unit[1])
        b = b.scaleb(eu[1]-target_unit[1])
        if a == b:
            return 'PASS'
        if mode == 'exact':
            return 'FAIL'
        return 'PASS' if a == b.quantize(Decimal(1).scaleb(-places), rounding=ROUND_HALF_UP) else 'FAIL'

def value_in_quote(value, quote):
    value = parse(value)
    if value is None or not isinstance(quote, str):
        return False
    tokens = re.findall(r'(?<![0-9A-Za-z_.])'+NUMBER+r'(?![0-9A-Za-z_.])', quote.replace(',', ''))
    return any(parse(token) == value for token in tokens)
