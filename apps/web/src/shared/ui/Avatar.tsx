import { useState } from 'react';

import { fullName, initials, possessive } from '../lib/names';
import { tokenList } from '../lib/token-list';
import './Avatar.css';

export type AvatarSize = 'small' | 'medium' | 'large';

export interface AvatarProps {
  firstName: string;
  lastName: string;
  /** `UserSummary.avatarUrl`: the stable `/api/users/<id>/avatar?v=<uuid>` route, or `null` (ADR-0010). */
  src: string | null;
  /** small 40px (rows, chat, header), medium 64px (wall posts), large 128px (profile). */
  size?: AvatarSize;
  /**
   * `true` only where the same name is announced right next to the picture in the same control; the picture is
   * then hidden from assistive technology (F-101: "decorative images alt=''").
   */
  decorative?: boolean;
  /** BEM element class of the parent block, mixed in (layout only). */
  className?: string;
}

/**
 * Square profile picture (ADR-0015: no radius, `object-fit: cover`, fixed sizes). Without a picture, or when the
 * image fails to load (`onError`, ADR-0010's last line of defence), it shows the initials in ink on the rose field.
 * The alt text is "<first> <last>'s profile picture" (F-101), built by `shared/lib/names` like every other name in the
 * UI; names are rendered as stored (F-58).
 */
export function Avatar({ firstName, lastName, src, size = 'small', decorative = false, className }: AvatarProps) {
  // Remember which URL failed instead of a boolean, so a new avatar URL (F-37) is tried again without an effect.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const label = `${possessive(fullName({ firstName, lastName }))} profile picture`;
  const imageSrc = src !== null && src !== '' && src !== failedSrc ? src : null;

  return (
    <span
      className={tokenList(
        'avatar',
        size === 'small' && 'avatar--small',
        size === 'medium' && 'avatar--medium',
        size === 'large' && 'avatar--large',
        className,
      )}
    >
      {imageSrc !== null ? (
        <img
          className="avatar__image"
          src={imageSrc}
          alt={decorative ? '' : label}
          loading="lazy"
          decoding="async"
          onError={() => {
            setFailedSrc(imageSrc);
          }}
        />
      ) : (
        <span
          className="avatar__initials"
          role={decorative ? undefined : 'img'}
          aria-label={decorative ? undefined : label}
          aria-hidden={decorative ? true : undefined}
        >
          {initials({ firstName, lastName })}
        </span>
      )}
    </span>
  );
}
