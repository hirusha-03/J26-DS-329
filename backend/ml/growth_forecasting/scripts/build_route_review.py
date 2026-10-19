import argparse, json
from pathlib import Path
import cv2, numpy as np

def main():
 p=argparse.ArgumentParser(description='Build a route-verification summary without modifying segmentation')
 p.add_argument('--image',required=True);p.add_argument('--observed',required=True);p.add_argument('--estimated',required=True);p.add_argument('--report',required=True);p.add_argument('--out',required=True)
 a=p.parse_args(); out=Path(a.out);out.mkdir(parents=True,exist_ok=True)
 im=cv2.imread(a.image); obs=cv2.imread(a.observed,0); est=cv2.imread(a.estimated,0)
 if im is None or obs is None or est is None: raise ValueError('Cannot read one or more images. Check paths.')
 h,w=im.shape[:2]
 if obs.shape!=(h,w) or est.shape!=(h,w): raise ValueError('Image and route masks must have identical dimensions.')
 # Final binary centerline: combine observed skeleton and estimated gap pixels.
 # Keep this separate from the SAM2 mask: interpolated sections are inferred.
 centerline=np.where((obs>127)|(est>127),255,0).astype(np.uint8)
 centerline_path=out/'final_main_stem_centerline.png'
 if not cv2.imwrite(str(centerline_path),centerline):
  raise IOError(f'Could not write {centerline_path}')
 r=json.loads(Path(a.report).read_text()); vis=im.copy()
 # Outlined strokes improve visibility on complex vegetation.
 for m,color in [(obs,(50,220,50)),(est,(0,175,255))]:
  b=(m>127).astype('uint8'); outline=cv2.dilate(b,np.ones((5,5),np.uint8))
  vis[outline>0]=(10,10,10); vis[b>0]=color
 for gap in r['gaps']:
  for key in ('from_xy','to_xy'):
   x,y=map(lambda z:int(round(z)),gap[key]);cv2.circle(vis,(x,y),4,(240,40,210),-1)
 # 3-panel board with legible labels
 width=440; scale=width/w; hh=int(round(h*scale))
 panels=[]
 for title,img in [('ORIGINAL PHOTOGRAPH',im),('OBSERVED ROUTE',cv2.imread(a.image)),('OBSERVED + ESTIMATED',vis)]:
  if title=='OBSERVED ROUTE':
   mask=(obs>127);img=im.copy(); img[mask]=(50,220,50)
  resized=cv2.resize(img,(width,hh),interpolation=cv2.INTER_AREA)
  panel=np.full((hh+75,width,3),245,np.uint8);panel[65:65+hh]=resized
  cv2.putText(panel,title,(12,34),cv2.FONT_HERSHEY_SIMPLEX,.65,(25,25,25),2,cv2.LINE_AA)
  panels.append(panel)
 board=np.hstack(panels)
 footer=np.full((145,board.shape[1],3),250,np.uint8)
 lines=[f"Observed: {r['observed_length_px']:.2f} px     Estimated gaps: {r['estimated_gap_length_px']:.2f} px     Candidate: {r['candidate_total_px']:.2f} px",'GREEN = skeleton-supported     ORANGE = estimated / unverified     MAGENTA = gap endpoints',f"{len(r['gaps'])} estimated gaps | 2D projected route only | No centimeter calibration | Hidden stem geometry unknown"]
 for i,line in enumerate(lines): cv2.putText(footer,line,(18,35+i*40),cv2.FONT_HERSHEY_SIMPLEX,.67,(25,25,25),2,cv2.LINE_AA)
 for filename, output_image in [
  ('main_stem_review_board.png', np.vstack([board,footer])),
  ('main_stem_review_overlay.png', vis),
 ]:
  output_path = out / filename
  if not cv2.imwrite(str(output_path), output_image):
   raise IOError(f'Could not write {output_path}')
 (out/'verification_notes.txt').write_text('MAIN-STEM ROUTE VERIFICATION\n\n'+ '\n'.join(lines)+'\n\nAll inferred gap curves require visual inspection. This is not a validated physical length.\n')
 print('Saved outputs to',out)
 print('Generated files:')
 for filename in ['main_stem_review_board.png', 'main_stem_review_overlay.png', 'final_main_stem_centerline.png', 'verification_notes.txt']:
  print(' -', out / filename)
if __name__=='__main__': main()
