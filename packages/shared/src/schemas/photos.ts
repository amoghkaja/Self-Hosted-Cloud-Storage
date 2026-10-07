import { z } from 'zod';
import { Bytes, Id, IsoDate, NodeName, UserRef } from './common';
import { ThumbStatus } from './files';

/** A calendar day, YYYY-MM-DD (no time zone: a trip's dates are the same everywhere). */
export const CalendarDate = z.iso.date();

/** `updatedAt` changes with the photo's contents: thumbnail addresses carry it (see thumbUrl). */
export const AlbumCover = z.object({ nodeId: Id, thumb: ThumbStatus, updatedAt: IsoDate });

export const Album = z.object({
  id: Id,
  title: z.string(),
  startDate: CalendarDate,
  endDate: CalendarDate.nullable(),
  note: z.string().nullable(),
  createdBy: UserRef.nullable(),
  /** Who was on the trip. */
  people: z.array(UserRef),
  photoCount: z.number().int(),
  cover: AlbumCover.nullable(),
  updatedAt: IsoDate,
});
export type Album = z.infer<typeof Album>;

export const AlbumDetail = Album.extend({
  /** On the trip (or started the album): may add photos. */
  canContribute: z.boolean(),
  /** Started the album, or an admin: may edit or delete it. */
  canEdit: z.boolean(),
});
export type AlbumDetail = z.infer<typeof AlbumDetail>;

export const AlbumList = z.object({ items: z.array(Album) });
export type AlbumList = z.infer<typeof AlbumList>;

export const AlbumsQuery = z.object({ person: Id.optional() });

const albumFields = {
  title: NodeName,
  startDate: CalendarDate,
  endDate: CalendarDate.nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
  peopleIds: z.array(Id).max(100),
};
const datesInOrder = (b: { startDate?: string; endDate?: string | null }) =>
  !b.startDate || !b.endDate || b.endDate >= b.startDate;

export const CreateAlbumBody = z
  .object(albumFields)
  .refine(datesInOrder, { message: 'The trip can’t end before it starts', path: ['endDate'] });

export const UpdateAlbumBody = z
  .object({ ...albumFields, coverNodeId: Id.nullable() })
  .partial()
  .refine(datesInOrder, { message: 'The trip can’t end before it starts', path: ['endDate'] });

export const AlbumPhoto = z.object({
  id: Id,
  name: z.string(),
  size: Bytes,
  mimeType: z.string().nullable(),
  thumb: ThumbStatus,
  addedBy: UserRef,
  createdAt: IsoDate,
  /** Changes with the contents (a saved-over photo): thumbnail addresses carry it. */
  updatedAt: IsoDate,
  /** When it was taken, on the camera's clock: "YYYY-MM-DDTHH:MM:SS" with no time zone. */
  takenAt: z.string().nullable(),
  /** Where it was taken, when the phone recorded it. */
  location: z.object({ latitude: z.number(), longitude: z.number() }).nullable(),
  hearts: z.number().int(),
  /** The caller gave it a heart. */
  hearted: z.boolean(),
  comments: z.number().int(),
});
export type AlbumPhoto = z.infer<typeof AlbumPhoto>;

export const AlbumPhotoPage = z.object({
  items: z.array(AlbumPhoto),
  nextCursor: z.string().nullable(),
});
export type AlbumPhotoPage = z.infer<typeof AlbumPhotoPage>;

export const AlbumPhotosQuery = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

/** Where the caller's photos for this album go (a folder in their own space). */
export const AlbumFolder = z.object({ folderId: Id });

export const PhotoComment = z.object({
  id: Id,
  author: UserRef,
  body: z.string(),
  createdAt: IsoDate,
  /** The author, the photo's owner or an admin may delete it. */
  canDelete: z.boolean(),
});
export type PhotoComment = z.infer<typeof PhotoComment>;

/** Hearts and comments on one album photo, oldest comment first. */
export const PhotoSocial = z.object({
  hearts: z.array(UserRef),
  hearted: z.boolean(),
  comments: z.array(PhotoComment),
});
export type PhotoSocial = z.infer<typeof PhotoSocial>;

export const CommentBody = z.object({ body: z.string().trim().min(1).max(1000) });
