package com.tmu.mobile;
public final class EndpointTest {
    static void accept(String s)throws Exception{Endpoint.validate(s);}
    static void reject(String s)throws Exception{try{Endpoint.validate(s);}catch(Exception e){return;}throw new AssertionError("Unsafe endpoint accepted");}
    public static void main(String[]args)throws Exception{
        accept("http://100.111.73.34:19100");accept("https://monitor.example.com");accept("http://127.0.0.1:19100");
        reject("http://8.8.8.8:19100");reject("http://100.63.0.1:19100");reject("http://100.128.0.1:19100");
        reject("http://100.111.73.34:19100/path");reject("https://user:secret@example.com");reject("https://example.com?token=x");
        if(!Endpoint.validate("http://100.111.73.34:19100/").equals("http://100.111.73.34:19100"))throw new AssertionError();
        System.out.println("Endpoint validation: 10 checks passed");
    }
}
