/**
 * Blog Posts Collection
 *
 * Example collection configuration for blog posts (SonicJS v3 document model)
 */

import type { CollectionConfig } from '@sonicjs-cms/core'

export default {
  name: 'blog_post',
  displayName: 'Blog Posts',
  slug: 'blog-posts',
  description: 'Manage your blog posts',
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
        type: 'user',
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

  // Opt in to public read access for the public API
  access: {
    public: ['read']
  },

  // Per-collection cache (seconds)
  cache: {
    enabled: true,
    ttl: 300
  }
} satisfies CollectionConfig
