/**
 * blogcms Collection
 *
 * Content collection for the blogcms document type.
 */

import type { CollectionConfig } from '@sonicjs-cms/core'

export default {
  name: 'blogcms',
  displayName: 'blogcms',
  slug: 'blogcms',
  description: 'Blog CMS content',
  icon: '📝',

  schema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        title: 'Title',
        required: true,
        maxLength: 200
      },
      slug: {
        type: 'slug',
        title: 'URL Slug',
        required: true,
        maxLength: 200
      },
      excerpt: {
        type: 'textarea',
        title: 'Excerpt',
        maxLength: 500,
        helpText: 'A short summary of the post'
      },
      content: {
        type: 'lexical',
        title: 'Content',
        required: true
      },
      featuredImage: {
        type: 'media',
        title: 'Featured Image'
      },
      author: {
        type: 'string',
        title: 'Author',
        required: true
      },
      publishedAt: {
        type: 'datetime',
        title: 'Published Date'
      },
      tags: {
        type: 'string',
        title: 'Tags',
        helpText: 'Comma-separated tags'
      },
      banner_image: {
        type: 'string',
        title: 'Banner Image'
      }
    },
    required: ['title', 'slug', 'content', 'author']
  },

  listFields: ['title', 'author', 'status', 'publishedAt'],
  searchFields: ['title', 'excerpt', 'content'],
  defaultSort: 'createdAt',
  defaultSortOrder: 'desc',

  managed: true,
  isActive: true,

  access: {
    public: ['read']
  },

  cache: {
    enabled: true,
    ttl: 300
  }
} satisfies CollectionConfig
