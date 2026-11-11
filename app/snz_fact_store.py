"""Server-owned annotations kept with facts; old planning clients preserve this dictionary."""
KEY = '__montage_reporting_v1'


def records(state, create=False):
    if create:
        return state['facts'].setdefault(KEY, {'notes': {}, 'extra': {}})
    return state['facts'].get(KEY, {'notes': {}, 'extra': {}})
