// The subset of Plex Media Server's JSON responses that MediaData reads.
// Plex doesn't publish a schema; every field is treated as optional.

export interface PlexTag {
    id?: number;
    tag?: string;
    tagKey?: string;
    role?: string;
    thumb?: string;
}

export interface PlexGuid {
    id?: string;
}

export interface PlexDirectory {
    key?: string;
    title?: string;
    type?: string;
}

export interface PlexItem {
    ratingKey?: string;
    type?: string;                   // 'movie' | 'show' | 'episode'
    guid?: string;
    title?: string;
    titleSort?: string;
    year?: number;
    audienceRating?: number;
    rating?: number;
    contentRating?: string;
    duration?: number;
    studio?: string;
    summary?: string;
    childCount?: number;
    leafCount?: number;
    viewedLeafCount?: number;
    // Episodes
    index?: number;                  // episode number within its season
    parentIndex?: number;            // season number
    originallyAvailableAt?: string;  // air date, YYYY-MM-DD
    addedAt?: number;
    updatedAt?: number;
    lastViewedAt?: number;
    viewCount?: number;
    thumb?: string;
    art?: string;
    Guid?: PlexGuid[];
    Genre?: PlexTag[];
    Country?: PlexTag[];
    Director?: PlexTag[];
    Writer?: PlexTag[];
    Role?: PlexTag[];
}

export interface PlexContainer<T> {
    MediaContainer?: {
        size?: number;
        Directory?: PlexDirectory[];
        Metadata?: T[];
    };
}
