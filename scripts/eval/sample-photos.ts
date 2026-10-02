/**
 * Demo-only sample photos, kept apart from the two eval sets so the
 * published eval numbers stay as they were measured. The counter offers them
 * like the eval photos (lib/samples.ts), and demo mode replays recorded
 * Gemini replies for them (lib/inspection/run.ts).
 *
 * `npm run eval:pairs -- --set samples` builds eval/samples: the image model
 * draws each pickup photo, and every edit is lined up with it and pasted back
 * only inside `regions` (scripts/eval/composite.ts), so the rest of the
 * return photo is the pickup photo's own pixels.
 */
import type { Box } from "./composite";
import type { Change } from "./make-pairs";

export type SampleScene = {
  /** Folder under eval/samples/images, and the sample key prefix. */
  id: string;
  /** lib/catalog.ts item whose kit list and price list fit the photo. */
  item: string;
  prompt: string;
};

/** One change asked of the image model, and the only area of its edit that is used. */
export type SampleStep = {
  /** File name of the model's full edit in eval/samples/.raw; edits that share a step share one model call. */
  name: string;
  instruction: string;
  region: Box;
};

export type SampleEdit = {
  /** `<scene id>__<variant>` */
  id: string;
  scene: string;
  /**
   * Each step edits the pickup photo on its own, and only its region is pasted
   * back, one after another: an image model asked for two changes at once
   * redraws more of the photo than one asked for a single change.
   */
  steps: SampleStep[];
  changes: Change[];
  session: "light" | "pose";
  /** Side effects of the image edit found on review; findings about them are neither right nor wrong. */
  incidental?: string[];
};

export const SAMPLE_STYLE =
  "A realistic, slightly imperfect smartphone photo taken by a bicycle rental shop employee at the shop's entrance. " +
  "Plain light-grey wall and smooth grey concrete floor behind the bike, soft even daylight. The bike and accessories have " +
  "no brand names, no logos and no readable text. No people, no hands, no watermark.";

export const SAMPLE_SCENES: SampleScene[] = [
  {
    id: "city-bike",
    item: "city-bike",
    prompt:
      "Side view of a whole city bicycle standing on its kickstand, the full bike in frame from the front tyre to the rear tyre " +
      "with some space around it, camera at handlebar height. A dark green step-through frame, black mudguards over both wheels, " +
      "a black chain guard, a black saddle and swept-back handlebars. No basket and no rear rack. The four rental accessories are " +
      "each clearly visible and well apart from each other: a small white front lamp mounted on the front of the head tube, below " +
      "the handlebar; an empty black phone holder (a clamp mount with four rubber grip corners, no phone in it) on the handlebar " +
      "next to the stem, clearly above the lamp; a small red rear light clipped to the seat post just under the saddle; and a " +
      "coiled black cable lock with orange ends hanging on a bracket on the frame's main tube, halfway between the handlebar and the pedals.",
  },
];

const PHONE_HOLDER: Change = {
  kind: "missing",
  item: "phone holder",
  detail: "phone holder removed",
  match: ["phone", "holder", "mount"],
  price: "missing-phone-holder",
};

const REMOVE_HOLDER: SampleStep = {
  name: "city-bike__remove-holder",
  instruction: "Remove the black phone holder from the handlebar, leaving the bare handlebar there.",
  region: [90, 405, 270, 580],
};

const REMOVE_REAR_LIGHT: SampleStep = {
  name: "city-bike__remove-rear-light",
  instruction:
    "Remove only the small red rear light clipped to the seat post just under the saddle, on the right of the photo, leaving the bare black seat post there.",
  region: [330, 645, 405, 715],
};

export const SAMPLE_EDITS: SampleEdit[] = [
  {
    id: "city-bike__missing-holder-rear-light",
    scene: "city-bike",
    steps: [REMOVE_HOLDER, REMOVE_REAR_LIGHT],
    changes: [
      PHONE_HOLDER,
      { kind: "missing", item: "rear light", detail: "rear light removed", match: ["rear", "tail"], price: "missing-rear-light" },
    ],
    session: "light",
  },
  {
    id: "city-bike__missing-holder",
    scene: "city-bike",
    steps: [REMOVE_HOLDER],
    changes: [PHONE_HOLDER],
    session: "pose",
  },
  {
    id: "city-bike__frame-scratch",
    scene: "city-bike",
    steps: [
      {
        name: "city-bike__frame-scratch",
        instruction:
          "Add one long, clearly visible scratch on the green paint of the frame's main tube, between the head tube and the cable lock, " +
          "where the paint is scraped down to bare silver metal.",
        region: [370, 340, 620, 540],
      },
    ],
    changes: [{ kind: "damage", item: "frame", detail: "scratches to bare metal on the frame", match: ["frame", "tube", "paint", "scratch"], price: "frame-scratch" }],
    session: "pose",
  },
];
