#!/usr/bin/env python3
"""Estimate missing portions of an already user-verified vine route.
Requires original route_report.json and skeleton. Never edits the segmentation.
Orange dashed sections are inferred, NOT observed vine pixels.
"""
import argparse, json, math, heapq
from pathlib import Path
import cv2
import numpy as np
from scipy.ndimage import label, distance_transform_edt

NEIGHBORS=[(dy,dx,math.hypot(dy,dx)) for dy in (-1,0,1) for dx in (-1,0,1) if dy or dx]
def path_between(mask,start,goal):
    if start==goal:return [start]
    h,w=mask.shape; pq=[(0.,start)]; dist={start:0.}; prev={}; visited=set()
    while pq:
        d,p=heapq.heappop(pq)
        if p in visited:continue
        visited.add(p)
        if p==goal:
            route=[p]
            while route[-1]!=start:route.append(prev[route[-1]])
            return route[::-1]
        y,x=p
        for dy,dx,c in NEIGHBORS:
            q=(y+dy,x+dx)
            if 0<=q[0]<h and 0<=q[1]<w and mask[q]:
                nd=d+c
                if nd<dist.get(q,float('inf')):
                    dist[q]=nd;prev[q]=p;heapq.heappush(pq,(nd,q))
    return None

def unit(v):
    n=np.linalg.norm(v)
    return v/n if n>1e-6 else None

def curve(p0,p1,t0,t1,scale,max_bend):
    chord=p1-p0; d=np.linalg.norm(chord)
    direct=chord/d
    # If tangent contradicts the direction of travel, use chord rather than inventing a loop.
    if t0 is None or np.dot(t0,direct)<0.15:t0=direct
    if t1 is None or np.dot(t1,direct)<0.15:t1=direct
    mag=scale*d
    ts=np.linspace(0,1,max(30,int(d*3)))[:,None]
    pts=(2*ts**3-3*ts**2+1)*p0+(ts**3-2*ts**2+ts)*(mag*t0)+(-2*ts**3+3*ts**2)*p1+(ts**3-ts**2)*(mag*t1)
    # Reject excessively curved or backtracking fits.
    length=float(np.linalg.norm(np.diff(pts,axis=0),axis=1).sum())
    if length>max_bend*d:
        pts=np.linspace(p0,p1,max(30,int(d*3)))
        return pts,'straight_fallback'
    return pts,'hermite'

def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--image',required=True);ap.add_argument('--skeleton',required=True)
    ap.add_argument('--report',required=True);ap.add_argument('--out',required=True)
    ap.add_argument('--tangent-pixels',type=float,default=20)
    ap.add_argument('--tangent-scale',type=float,default=0.55)
    ap.add_argument('--max-curve-ratio',type=float,default=1.8)
    ap.add_argument('--max-gap',type=float,default=160)
    args=ap.parse_args()
    if args.tangent_pixels<=0 or args.max_gap<=0 or args.tangent_scale<=0 or args.max_curve_ratio<1:
        ap.error('Invalid positive parameter')
    img=cv2.imread(args.image); sk=cv2.imread(args.skeleton,0)
    if img is None or sk is None:ap.error('Could not read image or skeleton')
    if img.shape[:2]!=sk.shape:ap.error('Image/skeleton dimensions do not match')
    data=json.loads(Path(args.report).read_text()); wps=data['waypoints_xy'];
    if len(wps)<2:ap.error('Need at least two waypoints')
    mask=sk>0; cc,_=label(mask,structure=np.ones((3,3),np.uint8))
    distance,nearest=distance_transform_edt(~mask,return_indices=True)
    points=[]
    for x,y in wps:
        if not(0<=x<mask.shape[1] and 0<=y<mask.shape[0]):ap.error('Waypoint outside image')
        if distance[y,x]>20:ap.error(f'Waypoint ({x},{y}) too far from skeleton')
        points.append((int(nearest[0,y,x]),int(nearest[1,y,x])))
    sections=[]
    for a,b in zip(points[:-1],points[1:]):
        path=path_between(mask,a,b) if cc[a] and cc[a]==cc[b] else None
        sections.append({'path':path,'a':a,'b':b})
    observed=np.zeros(mask.shape,np.uint8); estimated=np.zeros(mask.shape,np.uint8)
    overlay=img.copy(); records=[]; obs_len=0.; est_len=0.
    for i,s in enumerate(sections):
        path=s['path']
        if path is not None:
            for y,x in path:observed[y,x]=255
            obs_len+=sum(math.hypot(y2-y1,x2-x1) for (y1,x1),(y2,x2) in zip(path[:-1],path[1:]))
            continue
        a,b=s['a'],s['b']; p0=np.array([a[1],a[0]],float);p1=np.array([b[1],b[0]],float)
        d=float(np.linalg.norm(p1-p0));t0=t1=None
        if i>0 and sections[i-1]['path'] is not None:
            prev=sections[i-1]['path']; length=0.; j=len(prev)-1
            while j>0 and length<args.tangent_pixels:
                length+=math.dist(prev[j],prev[j-1]);j-=1
            t0=unit(p0-np.array([prev[j][1],prev[j][0]],float))
        if i+1<len(sections) and sections[i+1]['path'] is not None:
            nex=sections[i+1]['path'];length=0.;j=0
            while j<len(nex)-1 and length<args.tangent_pixels:
                length+=math.dist(nex[j],nex[j+1]);j+=1
            t1=unit(np.array([nex[j][1],nex[j][0]],float)-p1)
        if d>args.max_gap:
            records.append({'gap':len(records)+1,'section_index':i,'status':'flagged_too_long','chord_px':round(d,2)})
            cv2.line(overlay,tuple(p0.astype(int)),tuple(p1.astype(int)),(0,0,255),2)
            continue
        pts,method=curve(p0,p1,t0,t1,args.tangent_scale,args.max_curve_ratio)
        plen=float(np.linalg.norm(np.diff(pts,axis=0),axis=1).sum());est_len+=plen
        poly=np.rint(pts).astype(np.int32)
        cv2.polylines(estimated,[poly],False,255,1,cv2.LINE_8)
        # dashed orange curve
        for k in range(0,len(poly)-1,12):
            cv2.polylines(overlay,[poly[k:min(k+7,len(poly))]],False,(0,165,255),2,cv2.LINE_AA)
        records.append({'gap':len(records)+1,'section_index':i,'status':'estimated_unverified','method':method,'from_xy':p0.tolist(),'to_xy':p1.tolist(),'chord_px':round(d,2),'estimated_curve_px':round(plen,2),'length_ratio':round(plen/d,3),'tangents_available':bool(t0 is not None and t1 is not None)})
    # overlay observed route only after estimating gaps
    overlay[observed>0]=(0,220,0)
    for i,(y,x) in enumerate(points):
        cv2.circle(overlay,(x,y),3,(255,0,255),-1)
    out=Path(args.out);out.mkdir(parents=True,exist_ok=True)
    cv2.imwrite(str(out/'01_observed_route.png'),observed)
    cv2.imwrite(str(out/'02_estimated_gaps.png'),estimated)
    cv2.imwrite(str(out/'03_gap_filled_overlay.png'),overlay)
    result={'status':'ESTIMATED_ROUTE_REQUIRES_VISUAL_VERIFICATION','observed_length_px':round(obs_len,2),'estimated_gap_length_px':round(est_len,2),'candidate_total_px':round(obs_len+est_len,2),'estimated_gap_count':sum(r['status']=='estimated_unverified' for r in records),'flagged_gap_count':sum(r['status']!='estimated_unverified' for r in records),'gaps':records,'warning':'Estimated curves are inferred geometry, not observed stem. Candidate total is NOT a validated vine length. No segmentation pixels were changed.'}
    (out/'04_gap_fill_report.json').write_text(json.dumps(result,indent=2))
    print(json.dumps(result,indent=2));print('Saved to',out)
if __name__=='__main__':main()
