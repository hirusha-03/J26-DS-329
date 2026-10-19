#!/usr/bin/env python3
"""V8: multi-hypothesis SAM2 vine tracing with disagreement-driven review.

Experimental: candidate disagreement is an uncertainty proxy, NOT correctness.
Dependencies: guided_vine_tracer_v7.py and guided_vine_tracer_v6_sam2.py.
"""
import argparse
import json
from pathlib import Path
import cv2
import numpy as np
from scipy.ndimage import distance_transform_edt
from scipy.spatial import cKDTree
from skimage.graph import route_through_array
from guided_vine_tracer_v6_sam2 import predict_segment, path_length

HEADER = 108


def candidate_routes(img, predictor, a, b, negatives, args):
    mask, rect, score = predict_segment(predictor, img, a, b, negatives, args.crop_pad)
    x0, y0, x1, y1 = rect
    h, w = mask.shape
    lab = cv2.cvtColor(img[y0:y1, x0:x1], cv2.COLOR_BGR2LAB).astype(np.float32)
    anchors = np.stack((lab[a[1]-y0, a[0]-x0], lab[b[1]-y0, b[0]-x0]))
    colors = np.min(np.linalg.norm(lab[:, :, None, :] - anchors[None, None, :, :], axis=3), axis=2)
    colors = np.minimum(colors / 45.0, 3.0)
    inside = distance_transform_edt(mask).astype(np.float32)
    outside = distance_transform_edt(~mask).astype(np.float32)
    gray = cv2.cvtColor(img[y0:y1, x0:x1], cv2.COLOR_BGR2GRAY)
    edges = cv2.GaussianBlur(cv2.Canny(gray, 45, 120).astype(np.float32)/255., (5,5), 0)
    yy, xx = np.mgrid[:h, :w]
    p = np.array((a[0]-x0, a[1]-y0), np.float32)
    q = np.array((b[0]-x0, b[1]-y0), np.float32)
    delta = q-p
    t = np.clip(((xx-p[0])*delta[0]+(yy-p[1])*delta[1])/(np.dot(delta,delta)+1e-6),0,1)
    lateral = np.hypot(xx-(p[0]+t*delta[0]), yy-(p[1]+t*delta[1]))
    barrier = np.zeros((h,w),np.float32)
    for nx,ny in negatives:
        if x0<=nx<x1 and y0<=ny<y1:
            barrier += args.negative_penalty*np.exp(-((xx-(nx-x0))**2+(yy-(ny-y0))**2)/(2*args.negative_radius**2))
    # Three deliberately different hypotheses; not just three small changes to one weight.
    costs = [
        1 + 3.5*np.minimum(outside/7,4) + .5*np.maximum(inside-5,0) + .35*colors,
        1 + 1.2*np.minimum(outside/7,4) + 1.7*colors + .9*np.maximum(inside-4,0),
        1 + 1.5*np.minimum(outside/7,4) + .8*colors + 1.5*(1-edges) + .6*np.maximum(inside-5,0),
    ]
    paths=[]
    for cost in costs:
        cost = cost + 2.0*(np.maximum(lateral-args.corridor,0)/max(args.corridor,1))**2 + barrier
        pixels,_ = route_through_array(cost.astype(np.float32), (int(p[1]),int(p[0])),
                                       (int(q[1]),int(q[0])),fully_connected=True,geometric=True)
        xy=np.asarray([(x+x0,y+y0) for y,x in pixels],np.int32)
        xy[0]=a;xy[-1]=b
        paths.append(xy)
    # Symmetric nearest-neighbor distance: routes can agree even when all are wrong.
    disagreement=[]
    for i in range(3):
        for j in range(i+1,3):
            d1=cKDTree(paths[j]).query(paths[i][::max(1,len(paths[i])//200)],k=1)[0]
            d2=cKDTree(paths[i]).query(paths[j][::max(1,len(paths[j])//200)],k=1)[0]
            disagreement.append(float((np.mean(d1)+np.mean(d2))/2))
    disagreement_px=float(max(disagreement))
    chord=float(np.linalg.norm(delta))
    primary=paths[0]
    local=primary-np.array([x0,y0]); xs=local[:,0];ys=local[:,1]
    support=float(mask[ys,xs].mean())
    ratio=path_length(primary)/max(chord,1.)
    # Risk intentionally includes span even if hypotheses agree: shared shortcut bias.
    risk=float(np.clip(.42*min(chord/max(args.max_chord,1),1)
        +.35*min(disagreement_px/max(args.disagreement_threshold,1),1)
        +.15*(1-support)+.08*min(max(ratio-1.0,0),1),0,1))
    reasons=[]
    if chord>args.max_chord:reasons.append('long_span_shared_shortcut_possible')
    if disagreement_px>args.disagreement_threshold:reasons.append('candidate_disagreement')
    if support<.7:reasons.append('weak_mask_support')
    if ratio>1.6:reasons.append('detour')
    # Query position is where the alternatives diverge most from the primary.
    sample=primary[::max(1,len(primary)//150)]
    distances=[]
    for xy in sample:
        d=max(float(cKDTree(alt).query(xy,k=1)[0]) for alt in paths[1:])
        distances.append(d)
    # Never suggest endpoint; if candidates agree, query halfway along longest span.
    if len(sample)>2 and max(distances)>args.disagreement_threshold:
        idx=int(np.argmax(distances[1:-1]))+1
        hint=tuple(map(int,sample[idx]))
    else:
        hint=tuple(map(int,primary[len(primary)//2]))
    return dict(path=primary, alternatives=paths[1:],mask=mask,rect=rect,
                length=path_length(primary),chord=chord,disagreement_px=disagreement_px,
                support=support,risk=risk,reasons=reasons,hint=hint,mask_score=float(score))


def render(img,points,negatives,sections,selected,mode,corrections):
    canvas=img.copy();h,w=img.shape[:2]
    for i,s in enumerate(sections):
        if i==selected:
            for alt in s['alternatives']:
                cv2.polylines(canvas,[alt],False,(255,180,0),1,cv2.LINE_AA)
        color=(0,100,255) if i==selected else ((0,0,255) if s['reasons'] else (0,200,0))
        cv2.polylines(canvas,[s['path']],False,color,2,cv2.LINE_AA)
    for i,p in enumerate(points):
        cv2.circle(canvas,p,4,(255,0,255),-1)
        cv2.putText(canvas,str(i+1),(p[0]+5,p[1]-5),cv2.FONT_HERSHEY_SIMPLEX,.38,(255,255,255),1)
    for p in negatives:cv2.drawMarker(canvas,p,(0,0,255),cv2.MARKER_TILTED_CROSS,12,2)
    if sections:cv2.circle(canvas,sections[selected]['hint'],10,(255,255,0),2)
    header=np.full((HEADER,w,3),20,np.uint8)
    lines=['V8 | R highest risk | N/P section | C vine correction | B background | U undo',
           'Click only on actual vine; cyan circle = REVIEW SUGGESTION, not confirmed vine | S save | Esc exit',
           f'Mode {mode} | corrections {corrections} | negative clicks {len(negatives)}']
    if sections:
        s=sections[selected]
        lines.append(f'Section {selected+1}/{len(sections)} | chord {s["chord"]:.0f}px | disagreement {s["disagreement_px"]:.1f}px | risk {s["risk"]:.2f}')
    for i,line in enumerate(lines):cv2.putText(header,line,(4,17+24*i),cv2.FONT_HERSHEY_SIMPLEX,.36,(255,255,255),1,cv2.LINE_AA)
    return np.vstack([header,canvas])


def save(img,points,negatives,sections,args,corrections):
    out=Path(args.out);out.mkdir(parents=True,exist_ok=True)
    overlay=img.copy(); uncertainty=img.copy(); binary=np.zeros(img.shape[:2],np.uint8)
    mask_canvas=np.zeros_like(binary); data=[]; total=0
    for i,s in enumerate(sections):
        path=s['path'];total+=s['length']
        cv2.polylines(overlay,[path],False,(0,70,255) if s['reasons'] else (0,200,0),2,cv2.LINE_AA)
        cv2.polylines(uncertainty,[path],False,(0,0,255) if s['reasons'] else (0,200,0),3,cv2.LINE_AA)
        cv2.polylines(binary,[path],False,255,1,cv2.LINE_8)
        x0,y0,x1,y1=s['rect'];roi=mask_canvas[y0:y1,x0:x1];roi[s['mask']]=255
        cv2.circle(uncertainty,s['hint'],8,(255,255,0),2)
        data.append(dict(section=i+1,length_px=round(s['length'],2),chord_px=round(s['chord'],2),
                         candidate_disagreement_px=round(s['disagreement_px'],2),
                         mask_support=round(s['support'],3),risk_heuristic=round(s['risk'],3),
                         suggested_review_xy=list(s['hint']),review_reasons=s['reasons']))
    for i,p in enumerate(points):
        cv2.circle(overlay,p,4,(255,0,255),-1)
        cv2.putText(overlay,str(i+1),(p[0]+5,p[1]-5),cv2.FONT_HERSHEY_SIMPLEX,.4,(255,255,255),1)
    for name,image in [('guided_route_overlay.png',overlay),('uncertainty_overlay.png',uncertainty),
                       ('sam2_candidate_mask.png',mask_canvas),('full_vine_centerline.png',binary),
                       ('final_main_stem_centerline.png',binary)]:
        if not cv2.imwrite(str(out/name),image):raise OSError(f'Failed writing {name}')
    (out/'ordered_route_v8.json').write_text(json.dumps({'segments_xy':[s['path'].tolist() for s in sections]}))
    (out/'waypoints_v8.json').write_text(json.dumps({'waypoints_xy':points,'negative_points_xy':negatives},indent=2))
    (out/'guided_route_report.json').write_text(json.dumps(dict(status='EXPERIMENTAL_UNVERIFIED',
        method='V8 multi-hypothesis SAM2 candidate disagreement and risk-first correction',
        initial_positive_clicks=args.initial_clicks,correction_clicks=corrections,
        negative_clicks=len(negatives),total_clicks=len(points)+len(negatives),
        route_length_px=round(total,2),sections=data,
        warning='Candidate agreement does not prove accuracy. 2D pixel length only; validate against manual ground truth.'),indent=2))
    print(f'Saved {out}; candidate projected length {total:.2f}px; clicks {len(points)+len(negatives)}',flush=True)


def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--image',required=True);ap.add_argument('--out',required=True)
    ap.add_argument('--points-json',help='V7/V8 waypoints JSON or V6 report with waypoints_xy')
    ap.add_argument('--checkpoint',default='checkpoints/sam2.1_hiera_tiny.pt')
    ap.add_argument('--config',default='configs/sam2.1/sam2.1_hiera_t.yaml')
    ap.add_argument('--crop-pad',type=int,default=85)
    ap.add_argument('--corridor',type=int,default=35)
    ap.add_argument('--max-chord',type=float,default=130)
    ap.add_argument('--disagreement-threshold',type=float,default=8)
    ap.add_argument('--negative-penalty',type=float,default=25)
    ap.add_argument('--negative-radius',type=float,default=14)
    ap.add_argument('--no-gui',action='store_true')
    args=ap.parse_args();img=cv2.imread(args.image)
    if img is None:ap.error('Could not read image')
    h,w=img.shape[:2]
    if args.points_json:
        payload=json.loads(Path(args.points_json).read_text())
        points=[tuple(map(int,p)) for p in payload['waypoints_xy']]
        negatives=[tuple(map(int,p)) for p in payload.get('negative_points_xy',[])]
    else:
        if args.no_gui:ap.error('--no-gui requires --points-json')
        from guided_vine_tracer_v6_sam2 import collect
        points,negatives=collect(img)
        if points is None:return
    if len(points)<2 or any(not (0<=x<w and 0<=y<h) for x,y in points+negatives):
        ap.error('Need >=2 valid points inside image')
    args.initial_clicks=len(points)
    import torch
    from sam2.build_sam import build_sam2
    from sam2.sam2_image_predictor import SAM2ImagePredictor
    device='cuda' if torch.cuda.is_available() else 'cpu'
    print('Loading SAM2 on',device,flush=True)
    predictor=SAM2ImagePredictor(build_sam2(args.config,args.checkpoint,device=device))
    def trace(a,b):return candidate_routes(img,predictor,a,b,negatives,args)
    sections=[trace(a,b) for a,b in zip(points[:-1],points[1:])]
    if args.no_gui:save(img,points,negatives,sections,args,0);return
    name='V8 | multi-hypothesis review'
    cv2.namedWindow(name,cv2.WINDOW_NORMAL)
    cv2.resizeWindow(name,min(w,950),min(h+HEADER,1000))
    clicks=[]
    def mouse(event,x,y,flags,param):
        if event==cv2.EVENT_LBUTTONDOWN and 0<=x<w and HEADER<=y<h+HEADER:
            clicks.append((x,y-HEADER))
    cv2.setMouseCallback(name,mouse)
    selected=0;mode='correction';corrections=0
    while True:
        cv2.imshow(name,render(img,points,negatives,sections,selected,mode,corrections))
        key=cv2.waitKey(50)&255
        if clicks:
            p=clicks.pop(0)
            if mode=='background':
                negatives.append(p)
                sections=[trace(a,b) for a,b in zip(points[:-1],points[1:])]
            else:
                idx=selected+1;points.insert(idx,p)
                sections[selected:selected+1]=[trace(points[idx-1],p),trace(p,points[idx+1])]
                corrections+=1
                selected=max(range(len(sections)),key=lambda i:sections[i]['risk'])
        if key==27:break
        if key==ord('c'):mode='correction'
        elif key==ord('b'):mode='background'
        elif key==ord('n'):selected=(selected+1)%len(sections)
        elif key==ord('p'):selected=(selected-1)%len(sections)
        elif key==ord('r'):selected=max(range(len(sections)),key=lambda i:sections[i]['risk'])
        elif key==ord('u') and mode=='background' and negatives:
            negatives.pop();sections=[trace(a,b) for a,b in zip(points[:-1],points[1:])]
        elif key==ord('s'):
            save(img,points,negatives,sections,args,corrections);break
    cv2.destroyWindow(name)

if __name__=='__main__':main()
