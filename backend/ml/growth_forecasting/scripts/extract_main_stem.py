#!/usr/bin/env python3
"""Experimental, fully automatic main-stem candidate extraction from a SAM2 mask.

No human prompts. This does NOT prove that the chosen path is the biological main stem.
Requires: opencv-python numpy scipy scikit-image networkx
"""
import argparse
import json
from pathlib import Path
import cv2
import numpy as np
import networkx as nx
from skimage.morphology import skeletonize

NEIGHBORS = [(-1,-1),(-1,0),(-1,1),(0,-1),(0,1),(1,-1),(1,0),(1,1)]

def build_graph(skel):
    ys, xs = np.where(skel)
    pixels = set(zip(ys.tolist(), xs.tolist()))
    G = nx.Graph()
    G.add_nodes_from(pixels)
    for y,x in pixels:
        for dy,dx in NEIGHBORS:
            p=(y+dy,x+dx)
            if p in pixels and p>(y,x):
                G.add_edge((y,x),p,weight=float(np.hypot(dy,dx)),bridge=False)
    return G

def prune_spurs(G, threshold):
    """Remove terminal paths shorter than threshold, but retain free-standing paths."""
    G=G.copy()
    for _ in range(12):
        removal=set()
        for tip in [n for n,d in G.degree if d==1]:
            path=[tip]; dist=0.; prev=None; cur=tip
            while True:
                nbrs=[n for n in G.neighbors(cur) if n!=prev]
                if len(nbrs)!=1: break
                nxt=nbrs[0];dist+=G[cur][nxt]['weight'];path.append(nxt)
                prev,cur=cur,nxt
                if G.degree(cur)!=2:break
            if G.degree(cur)>=3 and dist<threshold:
                removal.update(path[:-1])
        if not removal:break
        G.remove_nodes_from(removal)
    return G

def bridge_components(G, max_gap, penalty):
    """Join only nearby endpoint pairs of distinct components, greedily.
    Artificial links are recorded and highlighted; they are not measured observations.
    """
    if max_gap<=0:return []
    components=list(nx.connected_components(G))
    labels={p:i for i,c in enumerate(components) for p in c}
    tips=[n for n,d in G.degree if d==1]
    candidates=[]
    for i,a in enumerate(tips):
        for b in tips[i+1:]:
            if labels[a]==labels[b]:continue
            distance=float(np.hypot(a[0]-b[0],a[1]-b[1]))
            if 0<distance<=max_gap:
                candidates.append((distance,a,b))
    candidates.sort(key=lambda z:z[0])
    used=set(); bridges=[]
    for distance,a,b in candidates:
        if a in used or b in used or nx.has_path(G,a,b):continue
        G.add_edge(a,b,weight=distance*penalty,bridge=True,distance_px=distance)
        used.update([a,b]);bridges.append((a,b,distance))
    return bridges

def choose_path(G,h):
    """Prefer maximum vertical coverage; among similar spans prefer shorter routes."""
    endpoints=[n for n,d in G.degree if d==1]
    if len(endpoints)<2:return [],None
    upper=[p for p in endpoints if p[0]<=int(h*.25)]
    lower=[p for p in endpoints if p[0]>=int(h*.75)]
    candidates=[]
    if upper and lower:
        for a in lower:
            lengths, paths=nx.single_source_dijkstra(G,a,weight='weight')
            for b in upper:
                if b in lengths:
                    candidates.append((b[0]-a[0],lengths[b],paths[b]))
    if not candidates:
        # Partial result: find the widest vertical span within connected components.
        for comp in nx.connected_components(G):
            ends=[p for p in comp if G.degree(p)==1]
            if len(ends)<2:continue
            lows=sorted(ends,reverse=True)[:8]
            highs=sorted(ends)[:8]
            for a in lows:
                lengths,paths=nx.single_source_dijkstra(G,a,weight='weight')
                for b in highs:
                    if b in lengths and a[0]>b[0]:
                        candidates.append((b[0]-a[0],lengths[b],paths[b]))
    if not candidates:return [],None
    # Maximize vertical coverage, with cost as tiebreaker.
    best=min(candidates,key=lambda x:(x[0],x[1]))
    return best[2],{'vertical_span_px':int(-best[0]),'weighted_path_cost':round(best[1],2)}

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--image',required=True)
    p.add_argument('--mask',required=True)
    p.add_argument('--out',required=True)
    p.add_argument('--min-area',type=int,default=30)
    p.add_argument('--spur-length',type=float,default=12)
    p.add_argument('--max-gap',type=float,default=0,help='Maximum artificial endpoint connection in px (default 0: disabled)')
    p.add_argument('--bridge-penalty',type=float,default=5)
    args=p.parse_args()
    image=cv2.imread(args.image)
    mask=cv2.imread(args.mask,cv2.IMREAD_GRAYSCALE)
    if image is None or mask is None:raise SystemExit('Cannot read image or mask. Check full file paths.')
    if image.shape[:2]!=mask.shape:raise SystemExit('Image/mask dimensions differ.')
    out=Path(args.out);out.mkdir(parents=True,exist_ok=True)
    h,w=mask.shape
    binary=np.uint8(mask>127)
    count,labels,stats,_=cv2.connectedComponentsWithStats(binary,8)
    filtered=np.zeros_like(binary)
    for i in range(1,count):
        if stats[i,cv2.CC_STAT_AREA]>=args.min_area:filtered[labels==i]=255
    cv2.imwrite(str(out/'01_clean_mask.png'),filtered)
    skel=skeletonize(filtered>0)
    cv2.imwrite(str(out/'02_raw_skeleton.png'),np.uint8(skel)*255)
    G=prune_spurs(build_graph(skel),args.spur_length)
    pruned=np.zeros_like(binary)
    for y,x in G.nodes:pruned[y,x]=255
    cv2.imwrite(str(out/'03_pruned_skeleton.png'),pruned)
    bridges=bridge_components(G,args.max_gap,args.bridge_penalty)
    path,summary=choose_path(G,h)
    selected=np.zeros_like(binary)
    for y,x in path:selected[y,x]=255
    cv2.imwrite(str(out/'04_candidate_main_path.png'),selected)
    overlay=image.copy()
    overlay[filtered>0]=(0.55*overlay[filtered>0]+0.45*np.array([0,180,255])).astype(np.uint8)
    for a,b in zip(path,path[1:]):
        is_bridge=bool(G[a][b].get('bridge',False))
        color=(0,0,255) if is_bridge else (0,255,0)
        cv2.line(overlay,(a[1],a[0]),(b[1],b[0]),color,2)
    if path:
        cv2.circle(overlay,(path[0][1],path[0][0]),5,(255,0,0),-1)
        cv2.circle(overlay,(path[-1][1],path[-1][0]),5,(255,255,0),-1)
    cv2.imwrite(str(out/'05_candidate_overlay.png'),overlay)
    path_bridges=sum(bool(G[a][b].get('bridge',False)) for a,b in zip(path,path[1:]))
    visible_length=sum(float(np.hypot(a[0]-b[0],a[1]-b[1])) for a,b in zip(path,path[1:]) if not G[a][b].get('bridge',False))
    info={'image_size':[w,h], 'foreground_pixels_initial':int(binary.sum()),'foreground_pixels_filtered':int((filtered>0).sum()),'graph_nodes':G.number_of_nodes(),'connected_components_after_pruning':nx.number_connected_components(G) if G.number_of_nodes() else 0,'candidate_found':bool(path),'candidate_reaches_upper_quarter':bool(path and min(y for y,x in path)<=h*.25),'candidate_reaches_lower_quarter':bool(path and max(y for y,x in path)>=h*.75),'artificial_bridges_in_candidate':path_bridges,'candidate_visible_centerline_pixels':round(visible_length,2),'note':'Candidate path is NOT validated main-stem length. Do not convert to centimeters before visual validation and calibration.'}
    if summary:info.update(summary)
    (out/'06_report.json').write_text(json.dumps(info,indent=2))
    print(json.dumps(info,indent=2))
    print('Saved results to',out)

if __name__=='__main__':main()
