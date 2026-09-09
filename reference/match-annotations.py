from pathlib import Path
import argparse
import sys

project = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(
    description='Match supplied annotation images against numbered reference frames.',
    epilog='Example: python reference/match-annotations.py image1.png image2.png',
)
parser.add_argument('images', nargs='+', type=Path, help='annotation image paths')
parser.add_argument('--frames', type=Path, default=project / 'reference' / 'motion',
                    help='directory containing numbered JPG frames (default: reference/motion)')
args = parser.parse_args()
sources = args.images
for source in sources:
    if not source.is_file():
        parser.error(f'image file does not exist: {source}')
frame_paths = list(args.frames.glob('[0-9]*.jpg'))
if not frame_paths:
    parser.error(f'no numbered JPG reference frames found in: {args.frames}')

sys.path.insert(0, str(project / '.tools'))
try:
    import cv2
    import numpy as np
except ImportError:
    parser.error('image matching requires OpenCV (opencv-python) and NumPy')

def read_image(image_path):
    image = cv2.imread(str(image_path))
    if image is None:
        parser.error(f'cannot decode image: {image_path}')
    return image

frames=[(p,cv2.resize(read_image(p),(480,270)).astype(float)) for p in frame_paths]
for source in sources:
    im=read_image(source)[:1080,:1920]
    im=cv2.resize(im,(480,270)).astype(float)
    mask=~((im[:,:,2]>170)&(im[:,:,1]>130)&(im[:,:,0]<160))
    mask[:55,:90]=False
    scores=sorted((np.mean(np.abs(im-f)[mask]),p.stem) for p,f in frames)
    print(Path(source).name,[(int(n)/25,round(float(s),2)) for s,n in scores[:4]])
