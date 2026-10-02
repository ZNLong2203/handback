/**
 * The real-photo eval set: freely licensed photographs from Wikimedia Commons
 * of gear like the demo shop rents out, and the changes the image model is
 * asked to make to each one. `npm run eval:pairs -- --set real` downloads the
 * exact file versions below (checked by sha1 and license), and writes
 * eval/real/CREDITS.md from this list.
 */
import type { Box } from "./composite";
import type { Change } from "./make-pairs";

export type AspectRatio = "1:1" | "4:3" | "3:2" | "16:9" | "21:9";

export type RealPhoto = {
  id: string;
  /** lib/catalog.ts item whose kit list and price list fit the photo. */
  item: string;
  /** What the photo shows, for CREDITS.md. */
  shows: string;
  commons: {
    file: string;
    page: string;
    sha1: string;
    author: string;
    license: "CC0" | "CC BY 2.0" | "CC BY 4.0" | "CC BY-SA 2.0" | "CC BY-SA 4.0";
    licenseUrl: string;
  };
  /** Part of the original to keep before cutting it to `aspect`; the whole photo when absent. */
  crop?: Box;
  /** An aspect ratio the image model can return, so its edit lines up with the original. */
  aspect: AspectRatio;
};

export type RealEdit = {
  /** `<photo id>__<variant>` */
  id: string;
  photo: string;
  instruction: string;
  /** Only this area of the model's edit is pasted onto the original photo; everything else stays the original pixels. */
  region: Box;
  changes: Change[];
  session: "light" | "pose";
  /** Side effects of the image edit found on review; findings about them are neither right nor wrong. */
  incidental?: string[];
};

export const REAL_PHOTOS: RealPhoto[] = [
  {
    id: "nikon-z6ii",
    item: "camera-body",
    shows: "Nikon Z 6II with a Nikkor Z 24-70mm f/4 S lens, white background",
    commons: {
      file: "Nikon Z 6II 10.jpg",
      page: "https://commons.wikimedia.org/wiki/File:Nikon_Z_6II_10.jpg",
      sha1: "73c8af73fe619c569707c817586bb27e162597bf",
      author: "Thilo Parg",
      license: "CC BY-SA 4.0",
      licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0",
    },
    aspect: "4:3",
  },
  {
    id: "lumix-s5ii",
    item: "camera-body",
    shows: "Panasonic Lumix S5II with a 50mm lens and strap on a wooden table",
    commons: {
      file: "Panasonic Lumix DC-S5II with Lumix S 50mm 1.8 2023-02-06.jpg",
      page: "https://commons.wikimedia.org/wiki/File:Panasonic_Lumix_DC-S5II_with_Lumix_S_50mm_1.8_2023-02-06.jpg",
      sha1: "ebef41cbcab50bf7ae3026061f42193997c64a95",
      author: "Sudo Work",
      license: "CC BY-SA 4.0",
      licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0",
    },
    aspect: "1:1",
  },
  {
    id: "sony-100-400",
    item: "tele-lens",
    shows: "Sony FE 100-400mm G Master with hood, tripod foot, 1.4x teleconverter and camera body, on a dining table",
    commons: {
      file: "Sony FE 100-400mm F4.5-5.6 G Master with x1.4 teleconverter (48315662811).jpg",
      page: "https://commons.wikimedia.org/wiki/File:Sony_FE_100-400mm_F4.5-5.6_G_Master_with_x1.4_teleconverter_(48315662811).jpg",
      sha1: "e0b41825c81508a78b65b785707d293fc5786da2",
      author: "Falcon® Photography from France",
      license: "CC BY-SA 2.0",
      licenseUrl: "https://creativecommons.org/licenses/by-sa/2.0",
    },
    crop: [0, 0, 1000, 960],
    aspect: "21:9",
  },
  {
    id: "sigma-150-600",
    item: "tele-lens",
    shows: "Sigma 150-600mm Sports lens with hood and tripod foot on a tripod head, white background",
    commons: {
      file: "Sigma 150-600mm F5-6.3 DG OS HSM S014 02.jpg",
      page: "https://commons.wikimedia.org/wiki/File:Sigma_150-600mm_F5-6.3_DG_OS_HSM_S014_02.jpg",
      sha1: "47eb0485e7bd888d8cb4cb951fcea44ca7cb3f95",
      author: "Gene Wang (retouched by Maksa)",
      license: "CC BY 2.0",
      licenseUrl: "https://creativecommons.org/licenses/by/2.0",
    },
    aspect: "16:9",
  },
  {
    id: "dji-mini4",
    item: "drone-kit",
    shows: "DJI Mini 4 Pro drone, arms unfolded, beside its remote controller, white background",
    commons: {
      file: "Drönare - Drone - DJI Mini 4 pro - 2026.jpg",
      page: "https://commons.wikimedia.org/wiki/File:Dr%C3%B6nare_-_Drone_-_DJI_Mini_4_pro_-_2026.jpg",
      sha1: "f5b5eb5973fc95d4eca69209998c135d62870c16",
      author: "Jonn Leffmann",
      license: "CC BY 4.0",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0",
    },
    aspect: "21:9",
  },
  {
    id: "sony-action-cam",
    item: "action-cam-kit",
    shows: "Sony HDR-AS50 action camera beside its underwater housing and mount, white background",
    commons: {
      file: "Sony HDR AS5 Action Cam 2 — Sven Volkens.jpg",
      page: "https://commons.wikimedia.org/wiki/File:Sony_HDR_AS5_Action_Cam_2_%E2%80%94_Sven_Volkens.jpg",
      sha1: "5efcd04e44d3e570f89e355644bc1faaea96f551",
      author: "Sven Volkens",
      license: "CC BY-SA 4.0",
      licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0",
    },
    aspect: "3:2",
  },
  {
    id: "jbl-boombox",
    item: "pa-speaker",
    shows: "JBL Boombox 2 portable speaker with carry handle, standing on its box",
    commons: {
      file: "JBL Boombox 2 1v2.jpg",
      page: "https://commons.wikimedia.org/wiki/File:JBL_Boombox_2_1v2.jpg",
      sha1: "673315fcb168b6fc2479999f604de45573b3d5f0",
      author: "Singlespeedfahrer",
      license: "CC0",
      licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
    },
    aspect: "16:9",
  },
  {
    id: "lg-projector",
    item: "projector",
    shows: "LG HX300 portable LED projector, front three-quarter view, white background",
    commons: {
      file: "LG전자, 작지만 화질과 편의성 강화한 미니 프로젝터 출시 (4599945883).jpg",
      page: "https://commons.wikimedia.org/wiki/File:LG%EC%A0%84%EC%9E%90,_%EC%9E%91%EC%A7%80%EB%A7%8C_%ED%99%94%EC%A7%88%EA%B3%BC_%ED%8E%B8%EC%9D%98%EC%84%B1_%EA%B0%95%ED%99%94%ED%95%9C_%EB%AF%B8%EB%8B%88_%ED%94%84%EB%A1%9C%EC%A0%9D%ED%84%B0_%EC%B6%9C%EC%8B%9C_(4599945883).jpg",
      sha1: "d725db038e7ef470aad9be4aca257ebb35cd01b9",
      author: "LG전자 (LG Electronics)",
      license: "CC BY 2.0",
      licenseUrl: "https://creativecommons.org/licenses/by/2.0",
    },
    aspect: "3:2",
  },
  {
    id: "ebike-rear",
    item: "ebike",
    shows: "Rear half of a Riese & Müller e-bike parked against a railing: frame battery, rear wheel, mudguard, rack with basket",
    commons: {
      file: "Riese & Müller e-bike side view.JPG",
      page: "https://commons.wikimedia.org/wiki/File:Riese_%26_M%C3%BCller_e-bike_side_view.JPG",
      sha1: "e261a33c96851845e32c2eca25ae7bac5139f45b",
      author: "Javier Carro",
      license: "CC BY-SA 4.0",
      licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0",
    },
    crop: [180, 330, 900, 1000],
    aspect: "4:3",
  },
  {
    id: "bike-rack",
    item: "ebike",
    shows: "Rear rack, white mudguard and red reflector of a bicycle, outdoors on paving",
    commons: {
      file: "Luggage carrier.jpg",
      page: "https://commons.wikimedia.org/wiki/File:Luggage_carrier.jpg",
      sha1: "255f1fcf8b6ce6252bfb7dd747f5afd3190b9e54",
      author: "Jeuwre",
      license: "CC BY-SA 4.0",
      licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0",
    },
    aspect: "3:2",
  },
  {
    id: "sony-a7r-kit",
    item: "camera-kit",
    shows: "Sony a7R body with body cap, laid out with its strap, battery, charger and cable protector, white background",
    commons: {
      file: "2026-07-25 Sony a7R VI mit Equipment HOF6440 RAW-Export.png",
      page: "https://commons.wikimedia.org/wiki/File:2026-07-25_Sony_a7R_VI_mit_Equipment_HOF6440_RAW-Export.png",
      sha1: "c80b9a5b3e937bcb5a8cc266ac829ad1736eeb69",
      author: "PantheraLeo1359531",
      license: "CC BY-SA 4.0",
      licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0",
    },
    aspect: "16:9",
  },
];

export const REAL_EDITS: RealEdit[] = [
  {
    id: "nikon-z6ii__top-scratch",
    photo: "nikon-z6ii",
    instruction:
      "Add one long, clearly visible scratch across the black top of the viewfinder housing, just in front of the hot shoe, where the paint is scraped down to bare silver metal.",
    region: [60, 500, 320, 800],
    changes: [{ kind: "damage", item: "camera top plate", detail: "long scratch to bare metal", match: ["top", "plate", "hot shoe", "viewfinder", "prism", "evf"], price: "top-plate" }],
    session: "light",
  },
  {
    id: "nikon-z6ii__cracked-front-element",
    photo: "nikon-z6ii",
    instruction: "Add a clearly visible crack running across the glass of the lens's front element.",
    region: [380, 200, 840, 520],
    changes: [{ kind: "damage", item: "front lens element", detail: "cracked front glass", match: ["front", "glass", "element", "lens"], price: "front-element" }],
    session: "pose",
  },
  {
    id: "lumix-s5ii__torn-grip",
    photo: "lumix-s5ii",
    instruction: "Make the textured rubber on the front of the handgrip (the left side of the camera) visibly torn, with a flap of rubber peeling away.",
    region: [270, 100, 520, 360],
    changes: [{ kind: "damage", item: "handgrip rubber", detail: "torn, peeling rubber", match: ["grip", "rubber"], price: "grip-rubber" }],
    session: "pose",
  },
  {
    id: "lumix-s5ii__barrel-dent",
    photo: "lumix-s5ii",
    instruction: "Add a clearly visible dent with scraped, chipped paint on the top edge of the lens's front rim, just above the LUMIX lettering.",
    region: [440, 80, 640, 470],
    changes: [{ kind: "damage", item: "lens barrel", detail: "dented, chipped front rim", match: ["barrel", "lens", "rim", "dent"], price: "lens-barrel" }],
    session: "light",
  },
  {
    id: "sony-100-400__cracked-hood",
    photo: "sony-100-400",
    instruction: "Add a long, clearly visible crack running through the white lens hood on the left.",
    region: [40, 60, 520, 320],
    changes: [{ kind: "damage", item: "lens hood", detail: "cracked hood", match: ["hood"], price: "hood-crack" }],
    session: "light",
  },
  {
    id: "sony-100-400__barrel-dent",
    photo: "sony-100-400",
    instruction:
      "Add a clearly visible dent with chipped paint on the white lens barrel, between the lens hood and the black zoom ring.",
    region: [100, 280, 460, 450],
    changes: [{ kind: "damage", item: "lens barrel", detail: "dent with chipped paint", match: ["barrel", "dent", "chip", "zoom ring", "focus ring"], price: "barrel-dent" }],
    session: "pose",
  },
  {
    id: "sigma-150-600__missing-hood",
    photo: "sigma-150-600",
    instruction:
      "Remove the wide black lens hood mounted on the front (left end) of the lens. The lens should now end at its narrower front barrel, just left of the zoom ring, with the plain white background where the hood was.",
    region: [100, 0, 720, 440],
    changes: [{ kind: "missing", item: "lens hood", detail: "hood removed", match: ["hood"], price: "missing-hood" }],
    session: "light",
  },
  {
    id: "sigma-150-600__broken-foot",
    photo: "sigma-150-600",
    instruction:
      "Snap off the left third of the long black tripod foot plate under the lens. The plate must now end abruptly about a third of the way in from its left end, at a rough broken edge; the broken-off part is gone, and the white background and the tripod head show where it was.",
    region: [700, 320, 930, 820],
    changes: [
      {
        kind: "damage",
        item: "tripod foot",
        detail: "left end of the foot plate chipped and jagged, bare metal showing (the model would not shorten the plate)",
        match: ["tripod", "foot", "plate", "collar"],
        price: "tripod-foot",
      },
    ],
    session: "pose",
  },
  {
    id: "dji-mini4__missing-controller",
    photo: "dji-mini4",
    instruction: "Remove the remote controller on the right. Fill its place with the plain white surface.",
    region: [0, 570, 1000, 1000],
    changes: [{ kind: "missing", item: "remote controller", detail: "controller removed", match: ["controller", "remote"], price: "missing-controller" }],
    session: "light",
  },
  {
    id: "dji-mini4__broken-propeller",
    photo: "dji-mini4",
    instruction: "Make the propeller at the lower right of the drone visibly snapped, with the outer half of one blade broken off.",
    region: [480, 380, 1000, 700],
    changes: [{ kind: "damage", item: "drone propeller", detail: "blade snapped off", match: ["propeller", "prop", "blade"], price: "propeller-damage" }],
    session: "pose",
  },
  {
    id: "sony-action-cam__missing-housing",
    photo: "sony-action-cam",
    instruction:
      "Remove the clear plastic waterproof housing on the left, including the black latch on its side. Keep the black mount it stands on exactly as it is, with the same shape and position. Fill the empty space with the plain white background.",
    region: [20, 0, 680, 560],
    changes: [{ kind: "missing", item: "waterproof housing", detail: "housing removed", match: ["housing", "case"], price: "missing-housing" }],
    session: "light",
    // The top of the mount was redrawn along with the housing, and a stub of the latch is left.
    incidental: ["mount", "latch", "buckle", "clip", "tab"],
  },
  {
    id: "sony-action-cam__cracked-lens",
    photo: "sony-action-cam",
    instruction: "Add a clearly visible crack across the glass of the action camera's round front lens.",
    region: [460, 780, 700, 960],
    changes: [{ kind: "damage", item: "camera lens", detail: "cracked lens glass", match: ["lens"], price: "camera-lens" }],
    session: "pose",
  },
  {
    id: "jbl-boombox__cracked-handle",
    photo: "jbl-boombox",
    instruction:
      "Break the dark green carry handle that arches over the top of the speaker: add a deep, clearly visible crack right through the handle's top bar near its middle, with a chunk of the plastic broken away.",
    region: [0, 250, 230, 750],
    changes: [{ kind: "damage", item: "carry handle", detail: "cracked handle", match: ["handle"], price: "handle" }],
    session: "light",
  },
  {
    id: "jbl-boombox__torn-grille",
    photo: "jbl-boombox",
    instruction:
      "Add a large, ragged tear in the fabric grille on the front, below and to the right of the JBL logo, with the black material behind it showing through.",
    region: [560, 580, 900, 900],
    changes: [{ kind: "damage", item: "speaker grille", detail: "torn fabric grille", match: ["grille", "fabric", "mesh", "cloth"], price: "grille" }],
    session: "pose",
  },
  {
    id: "lg-projector__cracked-lens",
    photo: "lg-projector",
    instruction: "Add a clearly visible crack running across the glass of the projector lens.",
    region: [400, 450, 720, 690],
    changes: [{ kind: "damage", item: "projector lens", detail: "cracked lens glass", match: ["lens"], price: "lens-crack" }],
    session: "light",
  },
  {
    id: "lg-projector__cracked-housing",
    photo: "lg-projector",
    instruction:
      "Add a long, clearly visible, dark crack in the white plastic casing on the left front side, running from the top edge down past the 'LED Projector' text, with small chips along the crack.",
    region: [300, 250, 830, 465],
    changes: [
      {
        kind: "damage",
        item: "projector housing",
        detail: "crack down the front of the casing, left of the lens (the model put it there, not by the text)",
        match: ["housing", "case", "casing", "body", "shell", "corner", "panel", "plastic"],
        price: "housing",
      },
    ],
    session: "pose",
  },
  {
    id: "ebike-rear__cracked-battery",
    photo: "ebike-rear",
    instruction: "Add a clearly visible crack with a broken-off chip at the lower corner of the black frame battery's plastic casing.",
    region: [380, 60, 700, 310],
    changes: [{ kind: "damage", item: "battery casing", detail: "cracked, chipped casing", match: ["battery"], price: "battery-damage" }],
    session: "pose",
  },
  {
    id: "ebike-rear__mud",
    photo: "ebike-rear",
    instruction: "Add thick splashes of dried brown mud over the red rear mudguard and the lower part of the rear wheel.",
    region: [340, 380, 1000, 960],
    changes: [{ kind: "dirt", item: "rear mudguard and wheel", detail: "dried mud", match: ["mud", "dirt"], price: "heavy-cleaning" }],
    session: "light",
  },
  {
    id: "bike-rack__bent-mudguard",
    photo: "bike-rack",
    instruction: "Make the rear end of the white mudguard (on the right) visibly bent outward and cracked.",
    region: [400, 700, 860, 1000],
    changes: [{ kind: "damage", item: "rear mudguard", detail: "cracked near the rear end (the edit shows no bend)", match: ["mudguard", "fender"], price: "mudguard" }],
    session: "light",
  },
  {
    id: "bike-rack__broken-reflector",
    photo: "bike-rack",
    instruction: "Smash the red rear reflector on the right so that its lower half is broken off and missing.",
    region: [150, 780, 650, 980],
    changes: [{ kind: "damage", item: "rear reflector", detail: "lower half broken off", match: ["reflector", "light", "lamp"], price: "rear-light" }],
    session: "pose",
  },
  {
    id: "sony-a7r-kit__missing-battery",
    photo: "sony-a7r-kit",
    instruction: "Remove the battery (the small black box at the bottom centre). Fill its place with the plain white background.",
    region: [640, 470, 900, 650],
    changes: [{ kind: "missing", item: "battery", detail: "battery removed", match: ["battery"], price: "missing-battery" }],
    session: "light",
  },
  {
    id: "sony-a7r-kit__missing-strap",
    photo: "sony-a7r-kit",
    instruction: "Remove the folded camera strap on the left. Fill its place with the plain white background, with no shadow or mark left behind.",
    region: [400, 10, 860, 350],
    changes: [{ kind: "missing", item: "neck strap", detail: "strap removed", match: ["strap"], price: "missing-strap" }],
    session: "pose",
  },
];
