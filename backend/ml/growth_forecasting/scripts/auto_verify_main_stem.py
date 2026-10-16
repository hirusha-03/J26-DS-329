#!/usr/bin/env python3
"""Experimental no-click main stem routing from a pruned binary skeleton.
Outputs a route_report.json compatible with auto_fill_stem_gaps.py.
Automatic routes are hypotheses and MUST be visually reviewed.
"""
import argparse, json, heapq, math
from pathlib import Path
import cv2
import numpy as np
from scipy.ndimage import label

NEIGH=[(dy,dx,math.hypot(dy,dx)) for dy in (-1,0,1) for dx in (-1,0,1) if dy or dx]

def dijkstra(nodes,start):
    dist={start:0.};prev={};pq=[(0.,start)]
    while pq:
        d,p=heapq.heappop(pq)
        if d>dist[p]+1e-9:continue
        for dy,dx,c in NEIGH:
            q=(p[0]+dy,p[1]+dx)
            if q not in nodes:continue
            nd=d+c
            if nd<dist.get(q,float('inf')):
                dist[q]=nd;prev[q]=p;heapq.heappush(pq,(nd,q))
    return dist,prev

def candidate(mask,lab,idx,min_pixels):
    yy,xx=np.where(lab==idx)
    if len(yy)<min_pixels:return None
    nodes=set(zip(yy.tolist(),xx.tolist()))
    ends=[]
    for p in nodes:
        degree=sum((p[0]+dy,p[1]+dx) in nodes for dy,dx,_ in NEIGH)
        if degree<=1:ends.append(p)
    # Fallback for loops: select extreme-y nodes.
    if len(ends)<2:
        ends=[min(nodes),max(nodes)]
    # Approximate graph diameter with two sweeps, evaluating endpoint seeds.
    seed=min(ends)
    d,_=dijkstra(nodes,seed)
    a=max(ends,key=lambda p:d.get(p,-1))
    d,prev=dijkstra(nodes,a)
    b=max(ends,key=lambda p:d.get(p,-1))
    path=[b]
    while path[-1]!=a:path.append(prev[path[-1]])
    path=path[::-1]
    if path[0][0]<path[-1][0]:path.reverse() # bottom -> top
    return {'id':idx,'path':path,'start':path[0],'end':path[-1],
            'length':sum(math.dist(u,v) for u,v in zip(path,path[1:])),
            'pixels':len(nodes)}

def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--image',required=True);ap.add_argument('--skeleton',required=True);ap.add_argument('--out',required=True)
    ap.add_argument('--max-gap',type=float,default=160)
    ap.add_argument('--min-component-pixels',type=int,default=8)
    ap.add_argument('--max-horizontal-drift',type=float,default=100)
    args=ap.parse_args()
    img=cv2.imread(args.image);sk=cv2.imread(args.skeleton,0)
    if img is None or sk is None:ap.error('Could not read image or skeleton')
    if img.shape[:2]!=sk.shape:ap.error('Image/skeleton sizes differ')
    mask=sk>0;lab,num=label(mask,structure=np.ones((3,3),np.uint8))
    comps=[candidate(mask,lab,i,args.min_component_pixels) for i in range(1,num+1)]
    comps=[c for c in comps if c and c['start'][0]>c['end'][0]]
    if not comps:ap.error('No usable skeleton components')
    # Bottom-up dynamic programming: maximize supported path length while
    # penalizing uncertain joins. Do not force connections longer than max-gap.
    comps.sort(key=lambda c:-c['start'][0]);n=len(comps)
    score=[c['length'] for c in comps];pred=[None]*n
    for j,b in enumerate(comps):
        for i,a in enumerate(comps[:j]):
            if a['end'][0] <= b['start'][0]:continue
            dist=math.dist(a['end'],b['start'])
            if dist>args.max_gap or abs(a['end'][1]-b['start'][1])>args.max_horizontal_drift:continue
            # Favor long observed support, small gaps, and gentle horizontal drift.
            candidate_score=score[i]+b['length']-0.85*dist-0.3*abs(a['end'][1]-b['start'][1])
            if candidate_score>score[j]:score[j]=candidate_score;pred[j]=i
    # Encourage coverage over image height, but don't force endpoints at borders.
    best=max(range(n),key=lambda j:score[j]+0.15*(img.shape[0]-comps[j]['end'][0]))
    chain=[]
    while best is not None:chain.append(comps[best]);best=pred[best]
    chain.reverse()
    # Use sparse ordered waypoints on each chosen observed path, including
    # exact component endpoints so downstream scripts detect gaps correctly.
    waypoints=[];segments=[];gaps=[];observed=np.zeros(mask.shape,np.uint8)
    for ci,c in enumerate(chain):
        path=c['path']
        for y,x in path:observed[y,x]=255
        if ci:
            a=chain[ci-1]['end'];b=c['start']
            gaps.append({'from_xy':[a[1],a[0]],'to_xy':[b[1],b[0]],'straight_line_px':round(math.dist(a,b),2)})
            segments.append({'type':'unresolved_gap'})
        stride=max(1,int(len(path)/max(2,math.ceil(c['length']/70))))
        picks=[path[k] for k in range(0,len(path),stride)]
        if picks[-1]!=path[-1]:picks.append(path[-1])
        for p in picks:
            if not waypoints or waypoints[-1]!=p:waypoints.append(p)
        segments.append({'type':'observed_skeleton','pixels':len(path)})
    overlay=img.copy();overlay[observed>0]=(0,220,0)
    for g in gaps:
        cv2.line(overlay,tuple(g['from_xy']),tuple(g['to_xy']),(0,165,255),2)
    for y,x in waypoints:cv2.circle(overlay,(x,y),2,(255,0,255),-1)
    out=Path(args.out);out.mkdir(parents=True,exist_ok=True)
    cv2.imwrite(str(out/'observed_route_mask.png'),observed)
    cv2.imwrite(str(out/'auto_verified_route_overlay.png'),overlay)
    report={'status':'AUTOMATIC_CANDIDATE_REQUIRES_VISUAL_REVIEW',
            'method':'component_graph_dynamic_programming_experimental',
            'waypoints_xy':[[x,y] for y,x in waypoints],
            'observed_skeleton_length_px':round(sum(c['length'] for c in chain),2),
            'unresolved_gap_count':len(gaps),'gaps':gaps,'segments':segments,
            'selected_component_ids':[c['id'] for c in chain],
            'warning':'Automatic route is not validated. Check branches, loops, gaps and endpoints against the photograph.'}
    (out/'route_report.json').write_text(json.dumps(report,indent=2))
    print(json.dumps({k:v for k,v in report.items() if k!='waypoints_xy'},indent=2))
    print('Saved to',out)
if __name__=='__main__':main()
