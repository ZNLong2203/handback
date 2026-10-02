"use client";

import { Camera, ImageUp, Loader2 } from "lucide-react";
import { useRef, useState, useTransition } from "react";
import { addPhotoAction } from "@/app/actions";
import { Button, cx } from "./ui";

export type SampleOption = { key: string; label: string; hint?: string };

/** Shrinks a phone photo before upload: the server only keeps 1600 px anyway. */
async function shrink(file: File, maxEdge = 1600): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("could not read the photo"))), "image/jpeg", 0.88));
}

export function PhotoCapture({
  rentalId,
  phase,
  shot,
  samples,
}: {
  rentalId: string;
  phase: "checkout" | "checkin";
  shot: string;
  samples: SampleOption[];
}) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const send = (build: (form: FormData) => Promise<void> | void, key: string) =>
    startTransition(async () => {
      setError(null);
      setBusyKey(key);
      try {
        const form = new FormData();
        form.set("rentalId", rentalId);
        form.set("phase", phase);
        await build(form);
        const res = await addPhotoAction(form);
        if (!res.ok) setError(res.error);
      } catch {
        setError("That photo could not be read. Try taking it again.");
      } finally {
        setBusyKey(null);
      }
    });

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-dashed border-line-strong bg-paper/60 p-5">
        <p className="text-sm text-ink-soft">
          <span className="font-semibold text-ink">Shot:</span> {shot}
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <input
            ref={input}
            type="file"
            accept="image/*"
            capture="environment"
            className="sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) send(async (form) => form.set("photo", await shrink(file), "photo.jpg"), "camera");
            }}
          />
          <Button variant="primary" size="lg" disabled={pending} onClick={() => input.current?.click()}>
            {busyKey === "camera" ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden /> : <Camera className="h-5 w-5" aria-hidden />}
            {phase === "checkout" ? "Take the pickup photo" : "Take the return photo"}
          </Button>
          <span className="text-xs text-muted">Opens the camera on a phone, or a file picker on a computer.</span>
        </div>
      </div>

      {samples.length > 0 && (
        <div>
          <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
            <ImageUp className="h-4 w-4" aria-hidden /> Or use a sample photo
            <span className="font-normal text-muted">(AI-generated, for trying the demo)</span>
          </p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {samples.map((s) => (
              <button
                key={s.key}
                type="button"
                disabled={pending}
                onClick={() => send((form) => form.set("sample", s.key), s.key)}
                className={cx(
                  "group overflow-hidden rounded-xl border border-line bg-card text-left transition hover:border-ink/30 disabled:opacity-60",
                  busyKey === s.key && "ring-2 ring-brand",
                )}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/api/samples/${s.key}`} alt="" className="aspect-[4/3] w-full object-cover" />
                <span className="block px-2.5 py-2 text-xs">
                  <span className="font-semibold">{s.label}</span>
                  {s.hint && <span className="block text-muted">{s.hint}</span>}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="rounded-xl bg-charged-soft px-3 py-2 text-sm font-medium text-charged">
          {error}
        </p>
      )}
    </div>
  );
}
