#!/usr/bin/env python3
"""Interactive waypoint-guided verification of a vine skeleton.
Click ordered points along the target stem, bottom to top. Paths within a
skeleton component are traced by shortest path; disconnected joins are flagged.
"""
import argparse, json, heapq
from pathlib import Path
import cv2
import numpy as np
from scipy.ndimage import label, distance_transform_edt

NEIGHBORS=[(dy,dx,float(np.hypot(dx,dy))) for dy in (-1,0,1) for dx in (-1,0,1) if dx or dy]

def shortest_path(mask, start, goal):
    if start==goal:return [start]
    h,w=mask.shape
    pq=[(0.,start)]; distances={start:0.}; parent={}; visited=set()
    while pq:
        d,(y,x)=heapq.heappop(pq)
        if (y,x) in visited:continue
        visited.add((y,x))
        if (y,x)==goal:
            path=[goal]
            while path[-1]!=start:path.append(parent[path[-1]])
            return path[::-1]
        for dy,dx,cost in NEIGHBORS:
            ny,nx=y+dy,x+dx
            if 0<=ny<h and 0<=nx<w and mask[ny,nx]:
                nd=d+cost
                if nd<distances.get((ny,nx),float('inf')):
                    distances[(ny,nx)]=nd;parent[(ny,nx)]=(y,x)
                    heapq.heappush(pq,(nd,(ny,nx)))
    return None

def main():
    p=argparse.ArgumentParser()
    p.add_argument('--image',required=True)
    p.add_argument('--skeleton',required=True)
    p.add_argument('--out',required=True)
    p.add_argument('--snap-radius',type=float,default=20)
    args=p.parse_args()
    image=cv2.imread(args.image);sk=cv2.imread(args.skeleton,cv2.IMREAD_GRAYSCALE)
    if image is None or sk is None:raise SystemExit('Cannot read image/skeleton; check paths')
    if image.shape[:2]!=sk.shape:raise SystemExit('Image and skeleton sizes differ')
    mask=sk>0
    if not mask.any():raise SystemExit('Skeleton is empty')
    cc,num=label(mask,structure=np.ones((3,3),dtype=np.uint8))
    # distance_transform_edt on inverse returns nearest foreground pixel indices
    dist,inds=distance_transform_edt(~mask,return_indices=True)
    clicks=[]
    window='Main stem verification | bottom -> top'
    def render():
        display=image.copy()
        display[mask]=cv2.addWeighted(display[mask],0.35,np.full_like(display[mask],(255,255,0)),0.65,0)
        for i,(y,x) in enumerate(clicks):
            cv2.circle(display,(x,y),5,(0,0,255),-1)
            cv2.putText(display,str(i+1),(x+7,y-7),cv2.FONT_HERSHEY_SIMPLEX,0.5,(255,255,255),2)
        cv2.putText(display,'Click bottom to top | U undo | C clear | ENTER save | Q quit',(6,24),cv2.FONT_HERSHEY_SIMPLEX,0.39,(0,0,0),3)
        cv2.putText(display,'Click bottom to top | U undo | C clear | ENTER save | Q quit',(6,24),cv2.FONT_HERSHEY_SIMPLEX,0.39,(255,255,255),1)
        cv2.imshow(window,display)
    def click(event,x,y,flags,param):
        if event==cv2.EVENT_LBUTTONDOWN:
            if dist[y,x]>args.snap_radius:
                print(f'Click ({x},{y}) is {dist[y,x]:.1f}px from skeleton; ignored')
                return
            sy,sx=int(inds[0,y,x]),int(inds[1,y,x]);clicks.append((sy,sx))
            print(f'Point {len(clicks)}: ({sx},{sy}), component {cc[sy,sx]}')
            render()
    cv2.namedWindow(window,cv2.WINDOW_NORMAL);cv2.setMouseCallback(window,click);render()
    while True:
        key=cv2.waitKey(0)&0xFF
        if key in (ord('q'),27):cv2.destroyAllWindows();return
        if key==ord('u') and clicks:clicks.pop();render()
        if key==ord('c'):clicks.clear();render()
        if key in (10,13):
            if len(clicks)<2:print('Select at least two points');continue
            break
    cv2.destroyAllWindows()
    overlay=image.copy();route=np.zeros(mask.shape,np.uint8)
    total=0.;gap_count=0;gaps=[];segments=[]
    for a,b in zip(clicks[:-1],clicks[1:]):
        if cc[a]==cc[b]:
            path=shortest_path(mask,a,b)
            if path is None:raise RuntimeError('Unexpected disconnected graph')
            for y,x in path:route[y,x]=255
            for (y1,x1),(y2,x2) in zip(path[:-1],path[1:]):total+=float(np.hypot(y2-y1,x2-x1))
            segments.append({'type':'observed_skeleton','pixels':len(path)})
        else:
            gap_count+=1
            gaps.append({'from_xy':[a[1],a[0]],'to_xy':[b[1],b[0]],'straight_line_px':float(np.hypot(b[0]-a[0],b[1]-a[1]))})
            segments.append({'type':'unresolved_gap'})
            cv2.line(overlay,(a[1],a[0]),(b[1],b[0]),(0,0,255),2,cv2.LINE_AA)
    overlay[route>0]=(0,255,0)
    for i,(y,x) in enumerate(clicks):
        cv2.circle(overlay,(x,y),4,(255,0,255),-1)
        cv2.putText(overlay,str(i+1),(x+6,y-6),cv2.FONT_HERSHEY_SIMPLEX,.4,(255,255,255),1)
    out=Path(args.out);out.mkdir(parents=True,exist_ok=True)
    cv2.imwrite(str(out/'verified_route_overlay.png'),overlay)
    cv2.imwrite(str(out/'observed_route_mask.png'),route)
    status='CONNECTED_CANDIDATE_REVIEW' if gap_count==0 else 'INCOMPLETE_GAPS_REQUIRE_REVIEW'
    report={'status':status,'waypoints_xy':[[x,y] for y,x in clicks], 'observed_skeleton_length_px':round(total,2), 'unresolved_gap_count':gap_count,'gaps':gaps,'segments':segments,'note':'Observed skeleton length excludes gaps. This is not a validated physical vine length; visually verify selected route and branch choices.'}
    (out/'route_report.json').write_text(json.dumps(report,indent=2))
    print(json.dumps(report,indent=2))
    print('Saved:',out)
if __name__=='__main__':main()
