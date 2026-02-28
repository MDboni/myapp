"use client"
import React, { use, useEffect } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { decrement, increament } from '../redux/slice/countSlice'
import { fetchPosts } from '../redux/slice/apiCall'
export default function HomeCompo() {
  const data = useSelector((state) => state.count);
  const { posts, loading, error } = useSelector((state) => state.post);

  const dispatch = useDispatch();

  useEffect(() => {
    // Fetch posts when the component mounts
    dispatch(fetchPosts());
  }, [dispatch]);

  const handleIncreament = (id) => {
    dispatch(increament({ id }));
  }

  const handleDecrement = (id) => {
    dispatch(decrement({ id }));
  }

    return (
    <div>
        <h2>Home Component</h2>
        {data.map((item) => (
          <div key={item.id}>
            <p>ID: {item.id}, Value: {item.value}</p>
            <button onClick={() => handleIncreament(item.id)}>Increment</button>
            <button onClick={() => handleDecrement(item.id)}>Decrement</button>             
          </div>
        ))}
        <h2>Posts</h2>
        {loading && <p>Loading...</p>}
        {error && <p>Error: {error}</p>}    
        {posts.map((post) => (
          <div key={post.id}>
            <h3>{post.title}</h3>
            <p>{post.body}</p>
          </div>
        ))}
    </div>
  )
}
