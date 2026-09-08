"""Unfold elevations onto shaft interior faces, then register named axes."""
from copy import deepcopy
from math import isfinite
from .parser import DrawingError


def _register(source, target):
    transform = []
    for kind,a,b in [('numeric','5','7'),('letter','Е','Ж')]:
        try:
            s0,s1 = (float(source[kind][k]) for k in (a,b))
            t0,t1 = (float(target[kind][k]) for k in (a,b))
        except (KeyError,TypeError,ValueError) as exc:
            raise DrawingError(f'В сетке объекта отсутствуют оси {a}, {b}') from exc
        if not all(isfinite(v) for v in (s0,s1,t0,t1)) or abs(s1-s0)<1:
            raise DrawingError('Некорректная сетка осей')
        scale = (t1-t0)/(s1-s0)
        if abs(abs(t1-t0)-abs(s1-s0)) > 1:
            raise DrawingError(f'Шаг осей {a}–{b} отличается от объекта; растягивать панели нельзя')
        sign = 1 if scale>0 else -1
        transform.append((sign,t0-sign*s0))
    return transform


def _plan_frames(drawing):
    vertical, horizontal = [], []
    for p in drawing['plan_shapes']:
        x0,y0,x1,y1 = p['bounds']; w,h = x1-x0,y1-y0
        if abs(w-300)<.1 and abs(h-5680)<.1:
            vertical.append(p)
        if abs(h-300)<.1 and abs(w-4495)<.1:
            horizontal.append(p)
    vertical.sort(key=lambda p:p['bounds'][0])
    if len(vertical)!=3 or len(horizontal)!=4:
        raise DrawingError('План шахт не соответствует профилю: 3 стенки 300×5680 и 4 стенки 4495×300')
    ylow = min(p['bounds'][3] for p in horizontal)
    yhigh = max(p['bounds'][1] for p in horizontal)
    if abs(yhigh-ylow-5700)>.1:
        raise DrawingError('Между внутренними гранями поперечных стенок не 5700 мм')
    frames = {}
    for i,shaft in enumerate(('ГП1','ГП2')):
        xl=vertical[i]['bounds'][2]; xr=vertical[i+1]['bounds'][0]
        if abs(xr-xl-4050)>.1:
            raise DrawingError('Внутренняя ширина шахты не 4050 мм')
        # Seen from inside each shaft: screen-right progresses clockwise
        # A north, Б east, В south, Г west. Origin is the inner face.
        for face,origin,u,n in zip('АБВГ' if i==0 else 'ДЕЖИ',
                [(xl,ylow),(xl,yhigh),(xr,yhigh),(xr,ylow)],
                [(0,1),(1,0),(0,-1),(-1,0)],
                [(-1,0),(0,1),(1,0),(0,-1)]):
            frames[face]={'shaft':shaft,'origin':origin,'u':u,'normal':n}
    return frames


def place_panels(drawing, target_axes, *, thickness_mm=None, z_offset_mm=0.):
    """None thickness gives precise front surfaces only, not invented solids.

    The drawing's 300 mm is a wall thickness, not an individual panel
    thickness. An explicit product thickness is required for DB commit.
    """
    if not isfinite(z_offset_mm):
        raise DrawingError('Некорректный сдвиг отметок')
    if thickness_mm is not None and (not isfinite(thickness_mm) or not 0<thickness_mm<=150):
        raise DrawingError('Толщина должна быть >0 и ≤150 мм (две облицовки в общей стенке 300 мм)')
    transform = _register(drawing['axes'],target_axes)
    frames = _plan_frames(drawing)
    result = deepcopy(drawing)
    result['target_axes'] = deepcopy(target_axes)
    result['registration'] = {'x_sign':transform[0][0],'dx_mm':transform[0][1],
                              'y_sign':transform[1][0],'dy_mm':transform[1][1],
                              'z_offset_mm':z_offset_mm}
    result['thickness_mm'] = thickness_mm
    result['commit_ready'] = thickness_mm is not None
    result['warnings'].append({'code':'plan_joint', 'message':'Развертка 5700 мм соответствует расстоянию между внутренними гранями поперечных стен; продольный контур плана 5680 мм оставляет по 10 мм стыка. Сохранены размеры развертки.'})
    if thickness_mm is None:
        result['warnings'].append({'code':'thickness_required','message':'В DXF есть толщина стенки 300 мм, но нет толщины отдельной облицовочной панели. Вычислены лицевые поверхности; для объемов требуется толщина изделия.'})
    placed = []
    for panel in result['panels']:
        frame=frames[panel['face']]
        ox,oy=frame['origin']; ux,uy=frame['u']; nx,ny=frame['normal']
        def xy(u, depth=0.):
            return [round((ox+ux*u+nx*depth)*transform[0][0]+transform[0][1],3),
                    round((oy+uy*u+ny*depth)*transform[1][0]+transform[1][1],3)]
        lo,hi=panel['u0_mm'],panel['u1_mm']
        z0,z1=panel['z_min_mm']+z_offset_mm,panel['z_max_mm']+z_offset_mm
        front=[xy(lo)+[z0],xy(hi)+[z0],xy(hi)+[z1],xy(lo)+[z1]]
        depth=thickness_mm or 0.
        outline=[xy(lo),xy(hi),xy(hi,depth),xy(lo,depth)] if thickness_mm else None
        center=xy((lo+hi)/2,depth/2)
        num=min(target_axes['numeric'],key=lambda a:abs(target_axes['numeric'][a]-center[0]))
        let=min(target_axes['letter'],key=lambda a:abs(target_axes['letter'][a]-center[1]))
        panel.update(front_xyz_mm=front, outline=outline, x=center[0],y=center[1],z=z0,
                     elevation_mm=z0, height_mm=round(z1-z0,3), thickness_mm=thickness_mm,
                     normal_xy=[nx*transform[0][0],ny*transform[1][0]],
                     nearest_axis_number=num,nearest_axis_letter=let,
                     offset_x_mm=round(center[0]-target_axes['numeric'][num],3),
                     offset_y_mm=round(center[1]-target_axes['letter'][let],3),
                     address=f"{panel['shaft']}, сторона {panel['face']}; {num}/{let}; Z {z0/1000:+.3f}…{z1/1000:+.3f}")
        placed.append(panel)
    result['panels']=placed
    return result
